#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="${SUPABASE_PROJECT_REF:-lbmbdjgsnenqjwjotoei}"
: "${SUPABASE_MANAGEMENT_TOKEN:?set SUPABASE_MANAGEMENT_TOKEN}"

SNAPSHOT_SQL=$(cat <<'SQL'
SELECT jsonb_build_object(
  'policies', (
    SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY policyname), '[]'::jsonb)
    FROM (
      SELECT policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'user_badges'
    ) p
  ),
  'privileges', jsonb_build_object(
    'anon_select', has_table_privilege('anon', 'public.user_badges', 'SELECT'),
    'anon_insert', has_table_privilege('anon', 'public.user_badges', 'INSERT'),
    'anon_update', has_table_privilege('anon', 'public.user_badges', 'UPDATE'),
    'anon_delete', has_table_privilege('anon', 'public.user_badges', 'DELETE'),
    'authenticated_select', has_table_privilege('authenticated', 'public.user_badges', 'SELECT'),
    'authenticated_insert', has_table_privilege('authenticated', 'public.user_badges', 'INSERT'),
    'authenticated_update', has_table_privilege('authenticated', 'public.user_badges', 'UPDATE'),
    'authenticated_delete', has_table_privilege('authenticated', 'public.user_badges', 'DELETE')
  ),
  'table_comment', obj_description('public.user_badges'::regclass, 'pg_class'),
  'row_count', (SELECT count(*) FROM public.user_badges)
) AS snapshot;
SQL
)

SQL=$(printf 'BEGIN;\n%s\n%s\n%s\nROLLBACK;\nSELECT true AS exclusive_badges_rls_sentinel, snapshot FROM (%s) final_state;\n' \
  'GRANT INSERT, UPDATE, DELETE ON public.user_badges TO anon, authenticated; CREATE POLICY "Users earn badges" ON public.user_badges FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);' \
  "$(<"$ROOT/supabase/migrations/20260803001500_user_badges_service_role_writes.sql")" \
  "$(<"$ROOT/scripts/qa/exclusive-badges-rls.assert.sql")" \
  "${SNAPSHOT_SQL%;}")

post_query() {
  local query="$1"
  curl --fail-with-body --silent --show-error \
    -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_MANAGEMENT_TOKEN" \
    -H "Content-Type: application/json" \
    -H "User-Agent: curl/8.4.0" \
    -d "$(jq -n --arg query "$query" '{query: $query}')"
}

BEFORE=$(post_query "$SNAPSHOT_SQL")
jq -e 'type == "array" and length == 1 and (.[0].snapshot | type == "object")' >/dev/null <<<"$BEFORE"

RESP=$(post_query "$SQL")
jq -e 'type == "array" and length == 1 and .[0].exclusive_badges_rls_sentinel == true and (.[0].snapshot | type == "object")' >/dev/null <<<"$RESP"

BEFORE_SNAPSHOT=$(jq -cS '.[0].snapshot' <<<"$BEFORE")
AFTER_SNAPSHOT=$(jq -cS '.[0].snapshot' <<<"$RESP")
if [[ "$BEFORE_SNAPSHOT" != "$AFTER_SNAPSHOT" ]]; then
  echo "exclusive badges RLS E2E: FAIL — rollback changed production snapshot" >&2
  diff -u <(printf '%s\n' "$BEFORE_SNAPSHOT") <(printf '%s\n' "$AFTER_SNAPSHOT") || true
  exit 1
fi

echo "exclusive badges RLS E2E: PASS (HTTP/schema/sentinel / anon+authenticated fail-close / public read / service-role / rollback snapshot)"
