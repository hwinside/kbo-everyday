-- 신고 3회 누적 시 자동 블라인드 + 작성자 안내 쪽지 (채팅/게시글/댓글 통합)
-- =========================================================================
-- 설계(삼순 NO-GO 반영):
--  1) 블라인드 전환을 신고 insert 와 "같은 트랜잭션"인 트리거 안에서 수행한다.
--     → 신고가 커밋되면 블라인드도 반드시 커밋(원자적). 애플리케이션 후처리(라우트
--       별도 호출)에서 발생하던 영구 누락 경로(config 누락/프로세스 종료/오류 삼킴)를 차단.
--  2) 전환 순간 durable outbox(report_blind_notices)에 안내 대상을 적재한다.
--     → 쪽지 발송은 크론(/api/cron/report-blind-notify)이 outbox 를 소비하며 재시도.
--       at-most-once 발송 유실을 at-least-once + 멱등(UNIQUE)으로 승격.
--  3) 배포 순서: 이 마이그레이션은 additive/backward-compatible 이다.
--     기존 게시글/댓글 3회 자동숨김(is_hidden) 동작을 그대로 유지하면서 채팅 블라인드와
--     outbox 적재만 추가하므로, 구버전 라우트가 배포 중이어도 자동숨김 공백이 생기지 않는다.
--     (마이그레이션 선적용 → 크론 코드 배포 순서로 진행)

-- ── 안내 쪽지 outbox (durable, 멱등) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_blind_notices (
  id           BIGSERIAL PRIMARY KEY,
  target_type  TEXT NOT NULL,          -- 'post' | 'comment' | 'chat'
  target_id    BIGINT NOT NULL,
  author_id    UUID,                   -- 작성자(탈퇴/미상이면 NULL → 크론이 스킵)
  blinded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at  TIMESTAMPTZ,            -- 발송 완료 시각(NULL=미발송)
  attempts     INT NOT NULL DEFAULT 0, -- 발송 시도 횟수(재시도 상한용)
  last_error   TEXT,
  UNIQUE (target_type, target_id)      -- 대상당 안내 1건 → 쪽지 멱등 키
);

CREATE INDEX IF NOT EXISTS idx_report_blind_notices_pending
  ON report_blind_notices (blinded_at)
  WHERE notified_at IS NULL;

-- service_role 전용(RLS on + 정책 0 → anon/authenticated 접근 차단, service_role 은 RLS 우회)
ALTER TABLE report_blind_notices ENABLE ROW LEVEL SECURITY;

-- ── 자동 블라인드 트리거(신고 insert 와 동일 트랜잭션) ────────────────────
CREATE OR REPLACE FUNCTION auto_blind_on_report()
RETURNS TRIGGER AS $$
DECLARE
  v_count   INT;
  v_author  UUID;
  v_blinded BOOLEAN := false;
  -- 시스템(크보팬 운영팀) 계정 — chat_messages.deleted_by(→profiles) 귀속용 안정 상수
  c_system  UUID := '7b58d68e-e212-40aa-a96d-5018cb82cc81';
BEGIN
  IF NEW.target_type = 'post' THEN
    UPDATE posts SET report_count = report_count + 1 WHERE id = NEW.target_id;
    -- 임계값 3 도달 순간에만 원자적으로 숨김 전환(가드: is_hidden=false)
    UPDATE posts SET is_hidden = true
      WHERE id = NEW.target_id AND is_hidden = false AND report_count >= 3
      RETURNING author_id INTO v_author;
    IF FOUND THEN v_blinded := true; END IF;

  ELSIF NEW.target_type = 'comment' THEN
    UPDATE comments SET report_count = report_count + 1 WHERE id = NEW.target_id;
    UPDATE comments SET is_hidden = true
      WHERE id = NEW.target_id AND is_hidden = false AND report_count >= 3
      RETURNING author_id INTO v_author;
    IF FOUND THEN v_blinded := true; END IF;

  ELSIF NEW.target_type = 'chat' THEN
    -- 채팅은 report_count 컬럼이 없어 reports 행 수로 판정(UNIQUE 제약 → 행수=신고자수)
    SELECT count(*) INTO v_count
      FROM reports WHERE target_type = 'chat' AND target_id = NEW.target_id;
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 트리거(trg_auto_blind)는 기존 그대로 유지 — 함수 본문만 교체한다.
