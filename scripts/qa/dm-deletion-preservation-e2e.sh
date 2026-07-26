#!/usr/bin/env bash
# DM / abuse-report shared-evidence preservation E2E.
#
# Applies the account-deletion FK migration, seeds two accounts + a
# conversation + messages + an abuse report, deletes account #1, and asserts
# the other party's history and the report evidence survive with the departed
# identity anonymized (SET NULL). Runs entirely inside ONE transaction that is
# ROLLBACKed, so it never mutates production data or the live FK definitions.
#
# Requires: SUPABASE_MANAGEMENT_TOKEN, SUPABASE_PROJECT_REF (default: prod ref).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="${SUPABASE_PROJECT_REF:-lbmbdjgsnenqjwjotoei}"
: "${SUPABASE_MANAGEMENT_TOKEN:?set SUPABASE_MANAGEMENT_TOKEN}"

SQL=$(printf 'BEGIN;\n%s\n%s\nROLLBACK;\n' \
  "$(cat "$ROOT/supabase/migrations/20260727_auth_user_delete_cascades.sql")" \
  "$(cat "$ROOT/scripts/qa/dm-deletion-preservation.assert.sql")")

RESP=$(curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_MANAGEMENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -Rs '{query: .}' <<<"$SQL")")

# The assert block RAISEs on any failure; success returns an empty result set.
if printf '%s' "$RESP" | grep -q '"message"'; then
  echo "DM preservation E2E: FAIL"
  echo "$RESP"
  exit 1
fi

echo "DM preservation E2E: PASS (transaction rolled back, production untouched)"
