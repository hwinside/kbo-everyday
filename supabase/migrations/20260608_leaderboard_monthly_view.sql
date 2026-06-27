-- 회원 레벨 / 랭킹 V1 — S3: 월별 글쓰기 리더보드 뷰
-- 스펙: specs/level-ranking-v1.md §4.2
-- 포인트 SSOT: src/lib/events/writing-points.ts
-- Exclusion SSOT: src/lib/events/leaderboard-exclusions.ts
--
-- 정책 (2026-06-06~08 스레드 확정):
--   - 월별(매월 1일 0시 KST 기준 파티션), 누적 랭킹과 별도.
--   - v_leaderboard_writing 과 동일 daily-capped CTE 재사용. 마지막 집계만
--     month_start = date_trunc('month', day) 로 GROUP BY (user_id, month_start).
--   - 일일캡 200은 월 경계와 무관하게 day 단위로 그대로 적용 (월 합산캡 없음).
--   - 파괴적 리셋 아님. 각 월이 독립 파티션 → "이번 달" = 현재 month_start 필터,
--     과거 월 = 아카이브 조회.

CREATE OR REPLACE VIEW v_leaderboard_writing_monthly AS
WITH
  chat_daily AS (
    SELECT
      user_id,
      (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
      LEAST(COUNT(*) * 1, 30) AS pts
    FROM chat_messages
    WHERE user_id <> ALL (leaderboard_internal_user_ids())
    GROUP BY user_id, day
  ),
  comment_daily AS (
    SELECT
      author_id AS user_id,
      (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
      LEAST(COUNT(*) * 2, 40) AS pts
    FROM comments
    WHERE is_hidden = FALSE
      AND author_id <> ALL (leaderboard_internal_user_ids())
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
      AND author_id <> ALL (leaderboard_internal_user_ids())
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
      AND author_id <> ALL (leaderboard_internal_user_ids())
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
      AND author_id <> ALL (leaderboard_internal_user_ids())
    GROUP BY author_id, day
  ),
  ticket_transfer_bonus_daily AS (
    SELECT
      author_id AS user_id,
      (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
      LEAST(COUNT(*) * 30, 30) AS pts
    FROM ticket_transfers
    WHERE author_id <> ALL (leaderboard_internal_user_ids())
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
  cd.user_id,
  date_trunc('month', cd.day)::date AS month_start,
  p.nickname,
  p.team_id,
  SUM(cd.day_pts)::int AS monthly_points,
  MAX(cd.day) AS last_active_day
FROM capped_daily cd
JOIN profiles p ON p.id = cd.user_id
GROUP BY cd.user_id, date_trunc('month', cd.day), p.nickname, p.team_id
ORDER BY month_start DESC, monthly_points DESC, MAX(cd.day) ASC;

GRANT SELECT ON v_leaderboard_writing_monthly TO anon, authenticated;
