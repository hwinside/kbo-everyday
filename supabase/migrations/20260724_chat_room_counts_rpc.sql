-- ============================================================
-- 크관 헤더 카운트 aggregate RPC — PR #821 (viewer×3 exact-count herd 해소)
-- ------------------------------------------------------------
-- 기존: viewer마다 총/홈/원정 head count 쿼리 3발 병렬 + 15초 동기화 재조회
--       → 100 viewer 기준 ~20 exact-count qps herd (삼순 라운드2 blocker 3).
-- 변경: 동일 시맨틱을 단일 쿼리로 집계. 클라이언트는 이 RPC를 우선 호출하고
--       미배포(PGRST202)/오류 시 기존 head 3발로 fallback하므로 배포 순서 안전.
--       reconcile 주기도 60s + jitter(0~15s)로 완화 — 즉시성은 클라이언트
--       낙관적 증분(trackCountDeltas)이 담당.
-- ⚠️ herd 해소 효과는 본 migration을 운영 DB에 적용한 뒤부터 발생
--    → 머지 게이트에서 운영 선적용 필요 (적용 전에도 기능은 fallback으로 동작).
-- 시맨틱(기존 클라이언트 쿼리와 동일):
--   - deleted_at IS NULL 만 집계 (soft delete 제외)
--   - 홈/원정 = 작성자 profiles.team_id 기준
-- 추가 반환(라운드3 blocker — in-flight lost-update fence):
--   - max_seen_id : 이 스냅샷의 최대 메시지 id(삭제 포함). 클라이언트는 이보다
--     큰 id의 INSERT를 "스냅샷 이후 도착"으로 보고 낙관적 +1을 보존한다.
--   - snapshot_at : 스냅샷 시각(now()). 이 시각 이후 삭제(deleted_at > snapshot_at)는
--     스냅샷엔 alive로 집계됐으므로 클라이언트가 -1을 보존한다.
-- ============================================================

-- RETURNS TABLE 시그니처가 바뀌므로(컬럼 추가) CREATE OR REPLACE 불가 → 선 DROP.
DROP FUNCTION IF EXISTS get_chat_room_counts(TEXT, INT, INT);

CREATE OR REPLACE FUNCTION get_chat_room_counts(
  p_room_id TEXT,
  p_home_team_id INT,
  p_away_team_id INT
)
RETURNS TABLE (
  total_count BIGINT,
  home_count BIGINT,
  away_count BIGINT,
  max_seen_id BIGINT,
  snapshot_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    COUNT(*) FILTER (WHERE m.deleted_at IS NULL)::BIGINT AS total_count,
    COUNT(*) FILTER (WHERE m.deleted_at IS NULL AND p.team_id = p_home_team_id)::BIGINT AS home_count,
    COUNT(*) FILTER (WHERE m.deleted_at IS NULL AND p.team_id = p_away_team_id)::BIGINT AS away_count,
    COALESCE(MAX(m.id), 0)::BIGINT AS max_seen_id,
    now() AS snapshot_at
  FROM chat_messages m
  LEFT JOIN profiles p ON p.id = m.user_id
  WHERE m.room_id = p_room_id;
$$;

-- SECURITY INVOKER(기본) — 기존 클라이언트 head count와 동일하게 호출자 RLS를 따른다.
-- (비로그인도 크관 카운트를 보므로 anon 포함. 원문 노출 없음 — 집계 수치만 반환.)
GRANT EXECUTE ON FUNCTION get_chat_room_counts(TEXT, INT, INT) TO anon, authenticated;

-- ------------------------------------------------------------
-- 배포 후 검증:
--   SELECT * FROM get_chat_room_counts('game:20260724OBLT0', 5, 1);
--   -- 기대: total/home/away + max_seen_id(방 최대 id) + snapshot_at(집계 시각) 1 row.
