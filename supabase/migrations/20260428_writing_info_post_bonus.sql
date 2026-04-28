-- 글쓰기 이벤트 정보성 게시물 보너스 반영
-- 요청: 2026-04-28 #marketing
-- 정책:
--   - 구장 좌석팁: 기본 글 점수와 별도 보너스 10점, 일일 보너스 상한 20점
--   - 티켓 양도: 보너스 30점, 일일 보너스 상한 30점
--   - 하루 총 상한 200점으로 상향

CREATE INDEX IF NOT EXISTS idx_posts_stadium_seat_tips_author_created
  ON posts (author_id, created_at)
  WHERE is_hidden = FALSE
    AND board_type = 'stadium'
    AND board_id LIKE 'stadium:%:seats';

CREATE INDEX IF NOT EXISTS idx_ticket_transfers_author_created
  ON ticket_transfers (author_id, created_at);

CREATE OR REPLACE VIEW v_leaderboard_writing AS
WITH
  -- 집계 정책 (2026-04-20 하린아빠 확정): 전체 누적 (lifetime) — 기간 필터 없음
  -- 이벤트 기간은 공지상 운영 프레임일 뿐, 집계는 가입 이후 모든 활동 포함
  -- 일일 측은 날짜별 스팸 방지 목적으로 그대로 유지
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
  p.nickname,
  p.team_id,
  SUM(cd.day_pts)::int AS total_points,
  MAX(cd.day) AS last_active_day
FROM capped_daily cd
JOIN profiles p ON p.id = cd.user_id
GROUP BY cd.user_id, p.nickname, p.team_id
ORDER BY total_points DESC, MAX(cd.day) ASC;

GRANT SELECT ON v_leaderboard_writing TO anon, authenticated;
