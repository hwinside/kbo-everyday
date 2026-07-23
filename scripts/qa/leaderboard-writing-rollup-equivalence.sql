-- 글쓰기 리더보드 rollup 동일성 검증 (읽기 전용)
-- 사용: 20260723_leaderboard_writing_rollup.sql 적용 직후(또는 아무 때나)
--       psql/SQL Editor에서 실행. 두 EXCEPT 결과가 모두 0 rows면 PASS.
-- 원리: 기존 v_leaderboard_writing(20260428) 정의를 인라인 재계산(legacy)한 결과와
--       rollup 기반 신규 뷰 결과를 양방향 EXCEPT 비교.
-- 주의: rollup은 최대 5분 지연 스냅샷이므로, 비교 직전
--       `SELECT leaderboard_writing_rollup_refresh();` (service_role) 실행 후 비교할 것.

WITH
  chat_daily AS (
    SELECT user_id, (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
           LEAST(COUNT(*) * 1, 30) AS pts
    FROM chat_messages
    WHERE user_id <> ALL (leaderboard_internal_user_ids())
    GROUP BY user_id, day
  ),
  comment_daily AS (
    SELECT author_id AS user_id, (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
           LEAST(COUNT(*) * 2, 40) AS pts
    FROM comments
    WHERE is_hidden = FALSE
      AND author_id <> ALL (leaderboard_internal_user_ids())
    GROUP BY author_id, day
  ),
  post_general_daily AS (
    SELECT author_id AS user_id, (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
           LEAST(COUNT(*) * 3, 30) AS pts
    FROM posts
    WHERE is_hidden = FALSE
      AND (content_type IS NULL OR content_type <> 'photo')
      AND author_id <> ALL (leaderboard_internal_user_ids())
    GROUP BY author_id, day
  ),
  post_photo_daily AS (
    SELECT author_id AS user_id, (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
           LEAST(COUNT(*) * 5, 50) AS pts
    FROM posts
    WHERE is_hidden = FALSE
      AND content_type = 'photo'
      AND author_id <> ALL (leaderboard_internal_user_ids())
    GROUP BY author_id, day
  ),
  stadium_seat_tip_bonus_daily AS (
    SELECT author_id AS user_id, (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
           LEAST(COUNT(*) * 10, 20) AS pts
    FROM posts
    WHERE is_hidden = FALSE
      AND board_type = 'stadium'
      AND board_id LIKE 'stadium:%:seats'
      AND author_id <> ALL (leaderboard_internal_user_ids())
    GROUP BY author_id, day
  ),
  ticket_transfer_bonus_daily AS (
    SELECT author_id AS user_id, (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
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
    SELECT user_id, day, LEAST(SUM(pts), 200) AS day_pts
    FROM all_daily
    GROUP BY user_id, day
  ),
  legacy AS (
    SELECT cd.user_id, p.nickname, p.team_id,
           SUM(cd.day_pts)::int AS total_points,
           MAX(cd.day) AS last_active_day
    FROM capped_daily cd
    JOIN profiles p ON p.id = cd.user_id
    GROUP BY cd.user_id, p.nickname, p.team_id
  ),
  current_view AS (
    SELECT user_id, nickname, team_id, total_points, last_active_day
    FROM v_leaderboard_writing
  ),
  diff AS (
    (SELECT 'legacy_only' AS side, * FROM (TABLE legacy EXCEPT SELECT * FROM current_view) x)
    UNION ALL
    (SELECT 'rollup_only' AS side, * FROM (SELECT * FROM current_view EXCEPT TABLE legacy) y)
  )
SELECT * FROM diff;
-- 기대 결과: 0 rows (양방향 차집합 공집합 = 결과 동일)
