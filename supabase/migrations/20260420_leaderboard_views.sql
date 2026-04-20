-- Leaderboard v1 (초대 + 글쓰기) 집계 뷰 + 필수 인덱스
-- 스펙: specs/leaderboard-v1.md
-- 포인트 SSOT: src/lib/events/writing-points.ts
-- Exclusion SSOT: src/lib/events/leaderboard-exclusions.ts
--
-- 중요 정책 (2026-04-20 하린아빠 & 삼순이 최종 GO):
--   - 초대: 기존 누적 + 이벤트 기간 활성화 모두 포함 (기간 필터 없음)
--   - 글쓰기: 이벤트 기간(2026-04-20 00:00 ~ 2026-05-31 23:59 KST)만 집계
--   - 내부자 7명은 리더보드에서 제외 (view 레벨에서 필터)

-- ============================================================
-- 1. 필수 인덱스 (없으면 생성)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_created
  ON chat_messages (user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_posts_author_created
  ON posts (author_id, created_at)
  WHERE is_hidden = FALSE;

CREATE INDEX IF NOT EXISTS idx_comments_author_created
  ON comments (author_id, created_at)
  WHERE is_hidden = FALSE;

CREATE INDEX IF NOT EXISTS idx_invitations_inviter_activated
  ON invitations (inviter_id, activated_at)
  WHERE activated_at IS NOT NULL AND flagged IS NOT TRUE;

-- ============================================================
-- 2. 내부자 제외 리스트 (SQL constant — TS SSOT와 1:1 매칭)
-- ============================================================

-- 변경 시 src/lib/events/leaderboard-exclusions.ts 도 함께 수정
CREATE OR REPLACE FUNCTION leaderboard_internal_user_ids()
RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    '04f1fcff-6173-4dda-920a-e5f8ff66a696'::uuid, -- seq 1 · 하린아빠
    '3e38a6c9-c43a-418f-8809-75db09ac247c'::uuid, -- seq 4 · 정배현우
    '7b58d68e-e212-40aa-a96d-5018cb82cc81'::uuid, -- seq 5 · 크보팬 운영팀
    '256c43ce-9a44-4c3e-9eb6-6bf64378bb4a'::uuid, -- seq 6 · 하린엄마
    'ee5c25d8-bcab-4bb1-aa11-f64041d5e322'::uuid, -- seq 7 · QA테스터
    '9cba194d-686d-4d17-b5ac-185b34bc2dc6'::uuid, -- seq 8 · 윤연률
    'a8b26be1-ea79-45d1-a6a4-9c5a13c91768'::uuid  -- seq 62 · 김현우
  ];
$$;

-- ============================================================
-- 3. 초대 리더보드 뷰
-- ============================================================

CREATE OR REPLACE VIEW v_leaderboard_invite AS
SELECT
  inv.inviter_id AS user_id,
  p.nickname,
  p.team_id,
  COUNT(*) AS invite_count,
  MAX(inv.activated_at) AS last_activated_at
FROM invitations inv
JOIN profiles p ON p.id = inv.inviter_id
WHERE inv.activated_at IS NOT NULL
  AND (inv.flagged IS NULL OR inv.flagged = FALSE)
  AND inv.inviter_id <> ALL (leaderboard_internal_user_ids())
GROUP BY inv.inviter_id, p.nickname, p.team_id
ORDER BY invite_count DESC, MAX(inv.activated_at) ASC;

-- ============================================================
-- 4. 글쓰기 리더보드 뷰 — 일일 캡 + 합산 일일 캡 적용
-- ============================================================
-- 포인트: chat 1 / comment 2 / post_general 3 / post_photo 5
-- 일일 캡: 30 / 40 / 30 / 50
-- 합산 일일 캡: 150
-- 이벤트 기간: 2026-04-20 00:00 KST ~ 2026-05-31 23:59:59 KST

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
  all_daily AS (
    SELECT user_id, day, pts FROM chat_daily
    UNION ALL SELECT user_id, day, pts FROM comment_daily
    UNION ALL SELECT user_id, day, pts FROM post_general_daily
    UNION ALL SELECT user_id, day, pts FROM post_photo_daily
  ),
  capped_daily AS (
    SELECT
      user_id,
      day,
      LEAST(SUM(pts), 150) AS day_pts
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

-- ============================================================
-- 5. RLS / 권한
-- ============================================================

GRANT SELECT ON v_leaderboard_invite TO anon, authenticated;
GRANT SELECT ON v_leaderboard_writing TO anon, authenticated;
