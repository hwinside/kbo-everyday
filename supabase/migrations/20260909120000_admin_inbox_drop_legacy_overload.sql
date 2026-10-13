-- Production retained a legacy argument order that is absent from repo migrations.
-- Its defaults make calls with only p_system_user_id/p_limit ambiguous in PostgREST.
-- Keep the canonical (UUID, TIMESTAMPTZ, UUID, INT) function and its ACL intact.
BEGIN;

-- Deliberately no CASCADE: unexpected database dependencies must block the cleanup.
DROP FUNCTION IF EXISTS public.admin_dm_inbox_page(UUID, INT, TIMESTAMPTZ, UUID);

NOTIFY pgrst, 'reload schema';
COMMIT;
