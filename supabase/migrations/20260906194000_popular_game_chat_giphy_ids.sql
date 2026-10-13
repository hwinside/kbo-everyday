-- Own usage-derived IDs only; never a GIPHY media/response cache.
-- Run before deploying the client. Reversible: drop the function/index.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX IF NOT EXISTS idx_chat_messages_public_gif_recent
  ON public.chat_messages (created_at DESC)
  WHERE deleted_at IS NULL AND room_id LIKE 'game:%'
    AND content LIKE 'https://media%.giphy.com/media/%';

CREATE OR REPLACE FUNCTION public.popular_game_chat_giphy_ids()
RETURNS TABLE (gif_id text)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '4s'
AS $function$
  WITH usage AS (
    SELECT
      substring(btrim(content) FROM
        '^https://media[0-9]*[.]giphy[.]com/media/(?:v1[.][A-Za-z0-9._-]+/)?([A-Za-z0-9_-]{1,78})/[^/?#]+(?:[?][^#]*)?$') AS gif_id,
      user_id, created_at
    FROM public.chat_messages
    WHERE deleted_at IS NULL AND room_id LIKE 'game:%'
      AND content LIKE 'https://media%.giphy.com/media/%'
      AND created_at >= now() - interval '30 days'
      AND created_at <= now()
  )
  SELECT usage.gif_id
  FROM usage
  WHERE usage.gif_id IS NOT NULL
  GROUP BY usage.gif_id
  ORDER BY count(*) DESC, count(DISTINCT user_id) DESC,
    max(created_at) DESC, usage.gif_id ASC
  LIMIT 24;
$function$;

-- The public API exposes only aggregate IDs, not messages/users/counts.
REVOKE ALL ON FUNCTION public.popular_game_chat_giphy_ids() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.popular_game_chat_giphy_ids() TO service_role;
COMMIT;
