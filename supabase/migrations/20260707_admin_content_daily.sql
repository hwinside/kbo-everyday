-- 콘텐츠 일별 카운트(게시글/댓글/사진/크관 채팅) 전 기간 DB 집계.
-- 어드민>콘텐츠 차트의 7일/30일/누적 토글용 — 누적은 런칭 이후 전 기간이
-- 필요해 row 페이지네이션 대신 RPC 한 방으로 내린다 (1000행 캡 구조적 소멸).
-- 필터는 /api/admin/content 기존 기준과 동일: 게시글은 announcement 브리지
-- 제외(board_type NOT NULL이라 <> 안전), 사진 = content_type='photo' 게시글,
-- 채팅 = room_id LIKE 'game:%'. service_role 전용, 어드민 PIN 게이트 뒤 호출.
CREATE OR REPLACE FUNCTION admin_content_daily()
RETURNS TABLE(day date, posts bigint, comments bigint, photos bigint, chats bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH p AS (
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
           count(*) AS posts,
           count(*) FILTER (WHERE content_type = 'photo') AS photos
    FROM posts
    WHERE board_type <> 'announcement'
    GROUP BY 1
  ),
  c AS (
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day, count(*) AS comments
    FROM comments
    GROUP BY 1
  ),
  ch AS (
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day, count(*) AS chats
    FROM chat_messages
    WHERE room_id LIKE 'game:%'
    GROUP BY 1
  )
  SELECT COALESCE(p.day, c.day, ch.day) AS day,
         COALESCE(p.posts, 0)    AS posts,
         COALESCE(c.comments, 0) AS comments,
         COALESCE(p.photos, 0)   AS photos,
         COALESCE(ch.chats, 0)   AS chats
  FROM p
  FULL OUTER JOIN c  ON c.day  = p.day
  FULL OUTER JOIN ch ON ch.day = COALESCE(p.day, c.day)
  ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION admin_content_daily() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_content_daily() TO service_role;
