#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="${SUPABASE_PROJECT_REF:-lbmbdjgsnenqjwjotoei}"
: "${SUPABASE_MANAGEMENT_TOKEN:?set SUPABASE_MANAGEMENT_TOKEN}"

SQL=$(printf 'BEGIN;\n%s\n%s\nROLLBACK;\n' \
  "$(<"$ROOT/supabase/migrations/20260803001500_user_badges_service_role_writes.sql")" \
  "$(<"$ROOT/scripts/qa/exclusive-badges-rls.assert.sql")")

RESP=$(curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_MANAGEMENT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "User-Agent: curl/8.4.0" \
  -d "$(jq -Rs '{query: .}' <<<"$SQL")")

if jq -e 'type == "object" and has("message")' >/dev/null <<<"$RESP"; then
  echo "exclusive badges RLS E2E: FAIL"
  jq -r '.message' <<<"$RESP"
  exit 1
fi

echo "exclusive badges RLS E2E: PASS (authenticated writes denied / service-role exclusive+ordinary allowed / rollback)"
