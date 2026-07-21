-- 기사 URL별 크보팬 댓글방. 언론사 본문은 저장하지 않고 URL/카드 메타데이터만 보관한다.
-- 기존 comments 스택을 재사용하기 위해 board_type='news' 숨김 posts 행을 bridge로 연결한다.
CREATE TABLE IF NOT EXISTS news_discussions (
  article_key text PRIMARY KEY,
  post_id bigint NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
  canonical_url text NOT NULL UNIQUE,
  source_url text NOT NULL,
  title text NOT NULL,
  source text,
  thumbnail_url text,
  team_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT news_discussions_team_id_check CHECK (team_id IS NULL OR team_id BETWEEN 1 AND 10)
);

ALTER TABLE news_discussions ENABLE ROW LEVEL SECURITY;
-- 정책 없음: service_role API만 조회/쓰기. comments/posts의 기존 RLS는 그대로 적용된다.

COMMENT ON TABLE news_discussions IS '기사 canonical URL과 기존 comments용 숨김 bridge post 연결. 기사 본문 저장 금지.';

-- 홈/댓글시트에 표시할 수 있는 댓글만 집계한다. posts.comment_count는 INSERT/DELETE
-- 카운터라 신고 블라인드(is_hidden 전환)를 반영하지 못하므로 뉴스 UI에서 사용하지 않는다.
CREATE OR REPLACE FUNCTION news_discussion_visible_counts(p_article_keys text[])
RETURNS TABLE(article_key text, visible_comment_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT nd.article_key, count(c.id) AS visible_comment_count
  FROM news_discussions nd
  LEFT JOIN comments c
    ON c.post_id = nd.post_id
   AND c.is_hidden IS DISTINCT FROM true
  WHERE nd.article_key = ANY(COALESCE(p_article_keys, ARRAY[]::text[]))
  GROUP BY nd.article_key;
$$;

REVOKE EXECUTE ON FUNCTION news_discussion_visible_counts(text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION news_discussion_visible_counts(text[]) TO service_role;

-- 새소식/뉴스 댓글용 bridge post는 게시글·사진 KPI에서 제외한다. 실제 댓글 활동은 comments 집계에 포함한다.
CREATE OR REPLACE FUNCTION admin_content_daily()
RETURNS TABLE(day date, posts bigint, comments bigint, photos bigint, chats bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH p AS (
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
           count(*) AS posts,
           count(*) FILTER (WHERE content_type = 'photo') AS photos
    FROM posts
    WHERE board_type NOT IN ('announcement', 'news')
    GROUP BY 1
  ),
  c AS (
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day, count(*) AS comments
    FROM comments GROUP BY 1
  ),
  ch AS (
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day, count(*) AS chats
    FROM chat_messages WHERE room_id LIKE 'game:%' GROUP BY 1
  )
  SELECT COALESCE(p.day, c.day, ch.day), COALESCE(p.posts, 0), COALESCE(c.comments, 0),
         COALESCE(p.photos, 0), COALESCE(ch.chats, 0)
  FROM p FULL OUTER JOIN c ON c.day = p.day
  FULL OUTER JOIN ch ON ch.day = COALESCE(p.day, c.day)
  ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION admin_content_daily() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_content_daily() TO service_role;

CREATE OR REPLACE FUNCTION admin_engaged_users_daily()
RETURNS TABLE(day date, engaged bigint, first_engaged bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH events AS (
    SELECT author_id AS user_id, (created_at AT TIME ZONE 'Asia/Seoul')::date AS day
    FROM posts WHERE author_id IS NOT NULL AND board_type NOT IN ('announcement', 'news')
    UNION ALL
    SELECT author_id, (created_at AT TIME ZONE 'Asia/Seoul')::date FROM comments WHERE author_id IS NOT NULL
    UNION ALL
    SELECT user_id, (created_at AT TIME ZONE 'Asia/Seoul')::date
    FROM chat_messages WHERE user_id IS NOT NULL AND room_id LIKE 'game:%'
  ),
  daily AS (
    SELECT events.day, count(DISTINCT user_id) AS engaged FROM events GROUP BY events.day
  ),
  firsts AS (
    SELECT min_day AS day, count(*) AS first_engaged
    FROM (SELECT user_id, min(events.day) AS min_day FROM events GROUP BY user_id) f GROUP BY min_day
  )
  SELECT d.day, d.engaged, COALESCE(fs.first_engaged, 0)
  FROM daily d LEFT JOIN firsts fs ON fs.day = d.day ORDER BY d.day;
$$;

REVOKE EXECUTE ON FUNCTION admin_engaged_users_daily() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_engaged_users_daily() TO service_role;
