-- List-only ranked feed. Keep gr_feed unchanged for comments and older clients.
-- Live keyset order: likes DESC, creation DESC, id DESC. Concurrent votes can
-- move rows across a cursor; clients deduplicate and refresh from page one after
-- their own mutations. This is not a frozen multi-request snapshot.
CREATE INDEX game_reviews_ranked_feed ON public.game_reviews(game_id,like_count DESC,created_at DESC,id DESC)
WHERE deleted_at IS NULL AND NOT is_hidden;

CREATE FUNCTION public.gr_feed_ranked(g text,a uuid DEFAULT NULL,filter_team integer DEFAULT NULL,p_best_min_likes integer DEFAULT NULL,
 cursor_likes integer DEFAULT NULL,cursor_created timestamptz DEFAULT NULL,cursor_id bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_best_min_likes IS NULL OR p_best_min_likes<1 OR p_best_min_likes>10000 THEN RAISE EXCEPTION 'gr_policy'; END IF;
 IF num_nonnulls(cursor_likes,cursor_created,cursor_id) NOT IN (0,3) OR cursor_likes<0 OR cursor_id<1 THEN RAISE EXCEPTION 'gr_input'; END IF;
 WITH visible AS MATERIALIZED (
   SELECT r.*,p.nickname FROM public.game_reviews r JOIN public.profiles p ON p.id=r.author_id
   WHERE r.game_id=g AND r.deleted_at IS NULL AND NOT r.is_hidden AND NOT public.gr_blocked(a,r.author_id)
 ), page AS (SELECT * FROM visible WHERE (cursor_likes IS NULL OR (like_count,created_at,id)<(cursor_likes,cursor_created,cursor_id)) AND (filter_team IS NULL OR team_id=filter_team) ORDER BY like_count DESC,created_at DESC,id DESC LIMIT 26),
 best AS (SELECT DISTINCT ON(team_id) * FROM visible WHERE like_count>=p_best_min_likes ORDER BY team_id,like_count DESC,created_at,id),
 needed AS (SELECT id FROM page UNION SELECT id FROM best UNION SELECT id FROM visible WHERE author_id=a),
 dto AS (
  SELECT v.id,v.author_id,v.team_id,v.nickname,v.content,v.created_at,v.edit_count,v.like_count,v.player_key,v.player_name,
  EXISTS(SELECT 1 FROM public.game_review_likes l WHERE l.review_id=v.id AND l.user_id=a) AS liked,
  (SELECT count(*) FROM public.game_review_comments c WHERE c.review_id=v.id AND c.deleted_at IS NULL AND NOT c.is_hidden AND NOT public.gr_blocked(a,c.author_id)) AS comment_count
  FROM visible v JOIN needed n ON n.id=v.id
 ), shown AS (SELECT dto.* FROM dto JOIN (SELECT id FROM page ORDER BY like_count DESC,created_at DESC,id DESC LIMIT 25) p USING(id))
 SELECT jsonb_build_object(
  'rows',coalesce((SELECT jsonb_agg(to_jsonb(shown) ORDER BY like_count DESC,created_at DESC,id DESC) FROM shown),'[]'),
  'best',coalesce((SELECT jsonb_agg(to_jsonb(dto) ORDER BY dto.team_id) FROM dto JOIN best USING(id)),'[]'),
  'total',(SELECT count(*) FROM visible),
  'team_counts',coalesce((SELECT jsonb_object_agg(team_id,n) FROM (SELECT team_id,count(*) n FROM visible GROUP BY team_id) counts),'{}'),
  'own',(SELECT jsonb_build_object('id',id,'hidden',is_hidden,'deleted',deleted_at IS NOT NULL) FROM public.game_reviews WHERE game_id=g AND author_id=a ORDER BY id DESC LIMIT 1),
  'ownReview',(SELECT to_jsonb(dto) FROM dto WHERE author_id=a),
  'next',CASE WHEN (SELECT count(*) FROM page)>25 THEN (SELECT jsonb_build_array(like_count,created_at,id)::text FROM shown ORDER BY like_count,created_at,id LIMIT 1) ELSE NULL END,
  'server_now',clock_timestamp()) INTO result;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.gr_feed_ranked(text,uuid,integer,integer,integer,timestamptz,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gr_feed_ranked(text,uuid,integer,integer,integer,timestamptz,bigint) TO service_role;
