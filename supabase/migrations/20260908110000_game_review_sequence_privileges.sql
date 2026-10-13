-- #1381 post-deploy review: Supabase defaults granted clients sequence USAGE
-- and UPDATE even though game review tables/RPCs are service-role-only.
-- Restrict only these two existing sequences; retain service_role privileges
-- and do not change global defaults or the already-applied original migration.
BEGIN;
REVOKE ALL ON SEQUENCE public.game_reviews_id_seq,
  public.game_review_comments_id_seq FROM PUBLIC, anon, authenticated;
COMMIT;
