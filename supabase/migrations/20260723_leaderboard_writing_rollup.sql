-- 글쓰기 리더보드 사전집계(rollup) — v_leaderboard_writing 호출당 전체 재집계 제거
-- 배경: pg_stat_statements 24h 실측 — v_leaderboard_writing 2,881콜 × 평균 316ms = 총 911초
--       (앱 쿼리 1위). 호출마다 chat_messages/comments/posts/ticket_transfers 전체 CTE 집계.
--       7/22 18시 conn pool 고갈 장애 재발 방지 목적.
-- 방식: 스냅샷 테이블 leaderboard_writing_rollup + cron(/api/cron/leaderboard-rollup, */5)이
--       전체 재계산(full recompute, ~316ms 1회/5분). 증분 upsert 대신 full recompute 채택 —
--       과거일 posts/comments hide·삭제, is_bot 재플래그 등 소급 변경에도 드리프트 0을 보장하고,
--       1회 비용이 기존 호출 1번과 동일(316ms)이라 증분화 이득이 없음 (Simplicity First).
--       DELETE+INSERT 단일 트랜잭션 → MVCC로 리더는 커밋 전까지 이전 스냅샷을 읽음(무차단).
--       (MATERIALIZED VIEW CONCURRENTLY는 PostgREST RPC 트랜잭션 안에서 실행 불가라 배제.)
-- 결과 동일성:
--   * 집계 CTE는 기존 뷰(20260428_writing_info_post_bonus.sql)와 자구 동일.
--   * 내부자/봇 제외(leaderboard_internal_user_ids(), STABLE·is_bot 동적)는 rollup이 아닌
--     "뷰 읽기 시점"에 적용 유지 → 봇 플래그 변경이 기존처럼 즉시 반영. 집계가 user 단위로
--     독립이므로 제외를 읽기로 미뤄도 비제외 유저 결과는 동일.
--   * nickname/team_id는 기존처럼 profiles 라이브 조인 → 닉네임 변경 즉시 반영.
--   * 유일한 차이 = 점수 신선도(최대 cron 주기 5분 지연; API는 이미 s-maxage=60 CDN 캐시).
-- 검증: scripts/qa/leaderboard-writing-rollup-equivalence.sql (기존 뷰 정의 vs rollup EXCEPT 비교)
-- 포인트 SSOT: src/lib/events/writing-points.ts
-- Exclusion SSOT: src/lib/events/leaderboard-exclusions.ts
-- 전례: 20260721_admin_traffic_dwell_rollup.sql (#773 트랙 admin rollup 패턴)

-- ============================================================
-- 1. 스냅샷 테이블
-- ============================================================

CREATE TABLE IF NOT EXISTS leaderboard_writing_rollup (
  user_id         uuid PRIMARY KEY,
  total_points    integer NOT NULL CHECK (total_points >= 0),
  last_active_day date NOT NULL,
  refreshed_at    timestamptz NOT NULL DEFAULT now()
);

-- 직접 접근 차단 (읽기는 v_leaderboard_writing 뷰 경유, 갱신은 service_role RPC 경유)
ALTER TABLE leaderboard_writing_rollup ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. 갱신 함수 — full recompute, idempotent
-- ============================================================
-- CTE 본문은 기존 v_leaderboard_writing(20260428) 정의와 동일하되
-- 내부자 제외 필터만 제거(뷰 읽기 시점에 적용 — 위 헤더 주석 참조).

CREATE OR REPLACE FUNCTION leaderboard_writing_rollup_refresh()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 단일 트랜잭션(함수 전체) 내 스냅샷 교체 — 리더는 커밋 전까지 이전 스냅샷 조회
  DELETE FROM leaderboard_writing_rollup;

  INSERT INTO leaderboard_writing_rollup (user_id, total_points, last_active_day)
  WITH
    chat_daily AS (
      SELECT
        user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*) * 1, 30) AS pts
      FROM chat_messages
      GROUP BY user_id, day
    ),
    comment_daily AS (
      SELECT
        author_id AS user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*) * 2, 40) AS pts
      FROM comments
      WHERE is_hidden = FALSE
      GROUP BY author_id, day
    ),
    post_general_daily AS (
      SELECT
        author_id AS user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*) * 3, 30) AS pts
      FROM posts
      WHERE is_hidden = FALSE
        AND (content_type IS NULL OR content_type <> 'photo')
      GROUP BY author_id, day
    ),
    post_photo_daily AS (
      SELECT
        author_id AS user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*) * 5, 50) AS pts
      FROM posts
      WHERE is_hidden = FALSE
        AND content_type = 'photo'
      GROUP BY author_id, day
    ),
    stadium_seat_tip_bonus_daily AS (
      SELECT
        author_id AS user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*) * 10, 20) AS pts
      FROM posts
      WHERE is_hidden = FALSE
        AND board_type = 'stadium'
        AND board_id LIKE 'stadium:%:seats'
      GROUP BY author_id, day
    ),
    ticket_transfer_bonus_daily AS (
      SELECT
        author_id AS user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*) * 30, 30) AS pts
      FROM ticket_transfers
      GROUP BY author_id, day
    ),
    all_daily AS (
      SELECT user_id, day, pts FROM chat_daily
      UNION ALL SELECT user_id, day, pts FROM comment_daily
      UNION ALL SELECT user_id, day, pts FROM post_general_daily
      UNION ALL SELECT user_id, day, pts FROM post_photo_daily
      UNION ALL SELECT user_id, day, pts FROM stadium_seat_tip_bonus_daily
      UNION ALL SELECT user_id, day, pts FROM ticket_transfer_bonus_daily
    ),
    capped_daily AS (
      SELECT
        user_id,
        day,
        LEAST(SUM(pts), 200) AS day_pts
      FROM all_daily
      GROUP BY user_id, day
    )
  SELECT
    user_id,
    SUM(day_pts)::int AS total_points,
    MAX(day) AS last_active_day
  FROM capped_daily
  GROUP BY user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION leaderboard_writing_rollup_refresh()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION leaderboard_writing_rollup_refresh() TO service_role;

-- ============================================================
-- 3. 뷰 교체 — 소비처(API 3곳) 무변경으로 rollup 읽기 전환
-- ============================================================
-- 컬럼명/타입/순서 기존과 동일: user_id, nickname, team_id, total_points, last_active_day

CREATE OR REPLACE VIEW v_leaderboard_writing AS
SELECT
  r.user_id,
  p.nickname,
  p.team_id,
  r.total_points,
  r.last_active_day
FROM leaderboard_writing_rollup r
JOIN profiles p ON p.id = r.user_id
WHERE r.user_id <> ALL (leaderboard_internal_user_ids())
ORDER BY r.total_points DESC, r.last_active_day ASC;

GRANT SELECT ON v_leaderboard_writing TO anon, authenticated;

-- ============================================================
-- 4. 초기 적재 — 마이그레이션 시점 1회 (이후 cron이 5분 주기 갱신)
-- ============================================================

SELECT leaderboard_writing_rollup_refresh();

ANALYZE leaderboard_writing_rollup;
