-- Keep the existing feed contract; bypass the RLS security barrier so the
-- (team_tags, created_at DESC, id DESC) partial index can stop after LIMIT.
-- This RPC is intentionally public-read, NOT a general-purpose posts reader.
-- SQL-language generic plans can still choose bitmap + sort after RLS bypass.
-- PL/pgSQL + per-function custom plans keep the actual team/limit/cursor visible
-- to the planner, including callers that force generic plans in their session.
-- Future posts visibility policies must update this definer RPC as well.
-- Fail closed if the current public-read premise or owner privileges drift.
DO $guard$
DECLARE caller text; owner_oid oid;
BEGIN
  FOREACH caller IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p
      WHERE p.polrelid = 'public.posts'::regclass
        AND p.polcmd IN ('r', '*') AND p.polpermissive
        AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true'
        AND (0::oid = ANY(p.polroles) OR EXISTS (
          SELECT 1 FROM unnest(p.polroles) role_oid
          WHERE role_oid <> 0 AND pg_catalog.pg_has_role(caller, role_oid, 'MEMBER')
        ))
    ) THEN
      RAISE EXCEPTION 'home latest definer requires unconditional posts SELECT for %', caller;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    WHERE p.polrelid = 'public.posts'::regclass
      AND p.polcmd IN ('r', '*') AND NOT p.polpermissive
  ) THEN
    RAISE EXCEPTION 'home latest definer cannot bypass restrictive posts SELECT policies';
  END IF;
  SELECT proowner INTO STRICT owner_oid FROM pg_catalog.pg_proc
    WHERE oid = 'public.home_team_latest_posts(text,integer,text[],uuid[],timestamptz,bigint)'::regprocedure;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r, pg_catalog.pg_class t
    WHERE r.oid = owner_oid AND t.oid = 'public.posts'::regclass
      AND (r.rolsuper OR r.rolbypassrls OR (t.relowner = owner_oid AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'home latest owner cannot bypass posts RLS';
  END IF;
END
$guard$;

create or replace function public.home_team_latest_posts(
  p_team_slug text,
  p_limit integer,
  p_other_kbo_ids text[] default '{}',
  p_blocked uuid[] default '{}',
  p_before_created_at timestamptz default null,
  p_before_id bigint default null
)
returns setof public.posts
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set plan_cache_mode = force_custom_plan
as $$
begin
  return query
  select p.*
  from public.posts p
  where p_team_slug is not null
    and p.is_hidden is not true
    and p.team_tags = jsonb_build_array(p_team_slug)
    and not (p.author_id = any (coalesce(p_blocked, '{}')))
    and not exists (
      select 1
      from jsonb_array_elements_text(coalesce(p.player_tags, '[]'::jsonb)) as t(tag)
      where split_part(t.tag, ':', 1) = any (coalesce(p_other_kbo_ids, '{}'))
    )
    and (
      (p_before_created_at is null and p_before_id is null)
      or (p.created_at, p.id) < (p_before_created_at, p_before_id)
    )
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(p_limit, 0), 0), 100);
end;
$$;

revoke all on function public.home_team_latest_posts(text, integer, text[], uuid[], timestamptz, bigint) from public;
grant execute on function public.home_team_latest_posts(text, integer, text[], uuid[], timestamptz, bigint) to anon, authenticated;
