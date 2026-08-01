#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C

PGBIN=""
for cand in "$(dirname "$(command -v initdb 2>/dev/null || true)")" /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if [ -n "$cand" ] && [ -x "$cand/initdb" ] && [ -x "$cand/psql" ]; then
    PGBIN="$cand"
    break
  fi
done
if [ -z "$PGBIN" ]; then
  echo "SKIP: local PostgreSQL(initdb/psql) not found" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260731180000_reject_unverified_kakao_signup.sql"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kakao-auth-hook-qa.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59349 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59349 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

"${PSQL[@]}" <<'SQL'
create role supabase_auth_admin nologin;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
SQL
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

call_hook() {
  local provider="$1"
  local email_verified_json="$2"
  "${PSQL[@]}" -c "select auth_hooks.reject_unverified_kakao(
    jsonb_build_object(
      'user', jsonb_build_object(
        'app_metadata', jsonb_build_object('provider', '$provider'),
        'user_metadata', jsonb_build_object('email_verified', $email_verified_json)
      )
    )
  );"
}

reject='{"error": {"message": "KAKAO_EMAIL_UNVERIFIED", "http_code": 422}}'
test "$(call_hook kakao false)" = "$reject"
test "$(call_hook kakao null)" = "$reject"
test "$("${PSQL[@]}" -c "select auth_hooks.reject_unverified_kakao(
  '{\"user\":{\"app_metadata\":{\"provider\":\"kakao\"},\"user_metadata\":{}}}'::jsonb
)")" = "$reject"
test "$(call_hook kakao true)" = "{}"
test "$(call_hook google false)" = "{}"
test "$(call_hook naver false)" = "{}"
test "$(call_hook apple false)" = "{}"

test "$("${PSQL[@]}" -c "select has_schema_privilege('supabase_auth_admin','auth_hooks','usage')")" = "t"
test "$("${PSQL[@]}" -c "select has_schema_privilege('anon','auth_hooks','usage')")" = "f"
test "$("${PSQL[@]}" -c "select has_function_privilege('supabase_auth_admin','auth_hooks.reject_unverified_kakao(jsonb)','execute')")" = "t"
test "$("${PSQL[@]}" -c "select has_function_privilege('anon','auth_hooks.reject_unverified_kakao(jsonb)','execute')")" = "f"
test "$("${PSQL[@]}" -c "select has_function_privilege('authenticated','auth_hooks.reject_unverified_kakao(jsonb)','execute')")" = "f"
test "$("${PSQL[@]}" -c "select has_function_privilege('service_role','auth_hooks.reject_unverified_kakao(jsonb)','execute')")" = "f"

echo "PASS: Kakao hook matrix 7/7, least-privilege matrix 6/6"
