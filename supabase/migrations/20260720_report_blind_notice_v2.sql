-- 신고 3회 자동 블라인드 — 삼순 2·3차 재리뷰 NO-GO 보완 (corrective forward migration)
-- =========================================================================
-- v1(20260720_report_blind_notice.sql)은 prod 선적용 완료라 amend 해도 재실행되지 않는다.
-- 따라서 아래 blocker 는 새 forward migration 으로 보완한다(추가 additive/backward-safe).
--
-- [2차 반영]
--   ① 동시 채팅 신고 race — 대상 단위 advisory xact lock 으로 count 판정을 직렬화.
--   ② outbox claim(lease) + DM 멱등키 — 크론 중첩/발송 직후 종료 시 중복 쪽지 차단.
--   ③ reason='block'(차단 시 자동 신고) 스코프 제외 — 오제재 방지(서로 다른 3명 직접 신고만).
--   ④ (크론 인증 우회 제거는 라우트 코드에서 처리)
--
-- [3차 반영]
--   ⑤ claim RPC trust boundary — PUBLIC/anon/authenticated EXECUTE 전면 revoke +
--      고정 search_path + 입력 clamp(일반 클라이언트의 outbox lease/attempts 소진 차단).
--   ⑥ dedup_key 위조 차단 — 비-service role 이 dm_messages.dedup_key 를 세팅/변경 못 하게
--      트리거로 봉인(선점으로 23505 성공 위조 방지). service role(크론)만 세팅 가능.
--   ⑦ dead-letter 상태 — attempts 소진 시 dead_lettered_at 마킹(영구 미발송을 관제 대상으로
--      노출, requeue = dead_lettered_at/attempts 리셋). claimable 에서 dead-letter 제외.

-- ── ⑦ dead-letter 컬럼 ────────────────────────────────────────────────────
ALTER TABLE report_blind_notices ADD COLUMN IF NOT EXISTS claimed_at      TIMESTAMPTZ;
ALTER TABLE report_blind_notices ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

-- claimable: 미발송 + dead-letter 아님(부분 인덱스)
DROP INDEX IF EXISTS idx_report_blind_notices_claimable;
CREATE INDEX IF NOT EXISTS idx_report_blind_notices_claimable
  ON report_blind_notices (blinded_at)
  WHERE notified_at IS NULL AND dead_lettered_at IS NULL;

-- ── ②⑤ 원자적 claim (lease) + trust boundary 봉인 ─────────────────────────
-- 미발송 + dead-letter 아님 + attempts 미만 + (미claim 또는 lease 만료)인 행만 SKIP LOCKED 로
-- 잠가 claimed_at/attempts 를 올리고 반환. 겹친 크론이 동시에 돌아도 같은 행을 두 번 안 집는다.
-- SECURITY DEFINER + 고정 search_path + 입력 clamp + service_role 전용 EXECUTE.
CREATE OR REPLACE FUNCTION claim_report_blind_notices(
  p_limit        INT      DEFAULT 50,
  p_max_attempts INT      DEFAULT 10,
  p_lease        INTERVAL DEFAULT interval '5 minutes'
)
RETURNS SETOF report_blind_notices
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE report_blind_notices n
     SET claimed_at = now(),
         attempts   = n.attempts + 1
    FROM (
      SELECT id
        FROM report_blind_notices
       WHERE notified_at    IS NULL
         AND dead_lettered_at IS NULL
         AND attempts < least(greatest(coalesce(p_max_attempts, 10), 1), 100)
         AND (claimed_at IS NULL
              OR claimed_at < now() - least(greatest(coalesce(p_lease, interval '5 minutes'), interval '30 seconds'), interval '1 hour'))
       ORDER BY blinded_at ASC
       LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
       FOR UPDATE SKIP LOCKED
    ) c
   WHERE n.id = c.id
   RETURNING n.*;
$$;

REVOKE ALL ON FUNCTION claim_report_blind_notices(INT, INT, INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_report_blind_notices(INT, INT, INTERVAL) TO service_role;

-- ── ⑦ dead-letter 마킹 RPC (service 전용) ─────────────────────────────────
-- 발송이 attempts 상한까지 실패한 outbox 를 dead-letter 로 확정(영구 미발송 관제).
CREATE OR REPLACE FUNCTION dead_letter_report_blind_notice(p_id BIGINT, p_error TEXT)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE report_blind_notices
     SET dead_lettered_at = now(),
         claimed_at       = NULL,
         last_error       = left(coalesce(p_error, 'dead_letter'), 500)
   WHERE id = p_id AND notified_at IS NULL;
$$;

REVOKE ALL ON FUNCTION dead_letter_report_blind_notice(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION dead_letter_report_blind_notice(BIGINT, TEXT) TO service_role;

-- ── ② DM 멱등키 (발송 성공 후 crash → 다음 틱 재발송 시 중복 차단) ─────────
-- 같은 안내 쪽지는 dedup_key 로 dm_messages 에 한 번만 들어간다. 재발송 insert 는
-- UNIQUE 위반(23505)으로 튕기고, 애플리케이션은 이를 "이미 발송됨=성공"으로 처리한다.
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS dedup_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dm_messages_dedup_key
  ON dm_messages (dedup_key)
  WHERE dedup_key IS NOT NULL;

-- ── ⑥ dedup_key 위조 차단 트리거 ──────────────────────────────────────────
-- dm_messages.dedup_key 는 service role(크론)만 세팅/변경할 수 있다. 일반 유저가
-- report-blind:{type}:{id} 를 선점해 크론 insert 의 23505 를 "이미 발송=성공"으로 위조하는
-- 경로를 원천 차단한다. is_read 등 일반 UPDATE 는 dedup_key 불변이라 영향 없음.
-- (PostgREST 는 service_role 키로 SET ROLE service_role → current_user='service_role')
CREATE OR REPLACE FUNCTION guard_dm_message_dedup_key()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.dedup_key IS NOT NULL AND current_user NOT IN ('service_role', 'postgres') THEN
      RAISE EXCEPTION 'dedup_key is reserved for service role';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.dedup_key IS DISTINCT FROM OLD.dedup_key AND current_user NOT IN ('service_role', 'postgres') THEN
      RAISE EXCEPTION 'dedup_key is immutable for non-service role';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_dm_dedup_key ON dm_messages;
CREATE TRIGGER trg_guard_dm_dedup_key
  BEFORE INSERT OR UPDATE ON dm_messages
  FOR EACH ROW EXECUTE FUNCTION guard_dm_message_dedup_key();

-- ── ①③ 자동 블라인드 함수 재정의 (race-free + block 제외) ─────────────────
CREATE OR REPLACE FUNCTION auto_blind_on_report()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count   INT;
  v_author  UUID;
  v_blinded BOOLEAN := false;
  -- 시스템(크보팬 운영팀) 계정 — chat_messages.deleted_by(→profiles) 귀속용 안정 상수
  c_system  UUID := '7b58d68e-e212-40aa-a96d-5018cb82cc81';
BEGIN
  -- ① 동일 대상에 대한 동시 신고 트리거를 직렬화한다(race-free count).
  --    advisory xact lock 은 커밋 시 자동 해제 → 뒤 트랜잭션이 앞 트랜잭션의 "커밋된"
  --    신고까지 정확히 세게 된다. lock 없으면 동시 3건이 서로를 못 봐서 임계값을 놓친다.
  PERFORM pg_advisory_xact_lock(
    hashtext('report_blind:' || NEW.target_type || ':' || NEW.target_id::text)
  );

  -- ③ "서로 다른 직접 신고자 수"만 센다. 차단 시 자동 생성되는 신고(reason='block')는
  --    오제재 방지를 위해 제외. reports UNIQUE(reporter_id,target_type,target_id) 이므로
  --    행 수 = 서로 다른 신고자 수.
  SELECT count(*) INTO v_count
    FROM reports
   WHERE target_type = NEW.target_type
     AND target_id   = NEW.target_id
     AND reason <> 'block';

  IF NEW.target_type = 'post' THEN
    -- report_count 는 표시용 누적 카운터(기존 유지). 숨김 판정은 직접 신고자 수 기준.
    UPDATE posts SET report_count = report_count + 1 WHERE id = NEW.target_id;
    IF v_count >= 3 THEN
      UPDATE posts SET is_hidden = true
        WHERE id = NEW.target_id AND is_hidden = false
        RETURNING author_id INTO v_author;
      IF FOUND THEN v_blinded := true; END IF;
    END IF;

  ELSIF NEW.target_type = 'comment' THEN
    UPDATE comments SET report_count = report_count + 1 WHERE id = NEW.target_id;
    IF v_count >= 3 THEN
      UPDATE comments SET is_hidden = true
        WHERE id = NEW.target_id AND is_hidden = false
        RETURNING author_id INTO v_author;
      IF FOUND THEN v_blinded := true; END IF;
    END IF;

  ELSIF NEW.target_type = 'chat' THEN
    IF v_count >= 3 THEN
      UPDATE chat_messages
         SET content    = '삭제된 메시지입니다',
             deleted_at = now(),
             deleted_by = c_system
       WHERE id = NEW.target_id AND deleted_at IS NULL
       RETURNING user_id INTO v_author;
      IF FOUND THEN v_blinded := true; END IF;
    END IF;
  END IF;

  -- 전환 성공 시에만 outbox 적재(멱등: 대상당 1건). 같은 트랜잭션이라 블라인드와 원자적.
  IF v_blinded THEN
    INSERT INTO report_blind_notices (target_type, target_id, author_id)
    VALUES (NEW.target_type, NEW.target_id, v_author)
    ON CONFLICT (target_type, target_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

-- 트리거(trg_auto_blind AFTER INSERT ON reports)는 기존 그대로 — 함수 본문만 교체.
