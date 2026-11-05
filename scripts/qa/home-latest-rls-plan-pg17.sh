#!/usr/bin/env bash
# Actual nested plans, role/contract equivalence and migration guard regression.
# No production connection, no silent SKIP, no workflow edits required.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
for cand in "${PGBIN:-}" "$(dirname "$(command -v initdb 2>/dev/null || true)")" /usr/lib/postgresql/17/bin /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if [[ -x "$cand/initdb" && -x "$cand/psql" && -x "$cand/pg_ctl" ]] && "$cand/postgres" --version | grep -Eq 'PostgreSQL\) 17\.'; then
    export PGBIN="$cand"
    export PG_TEST_ROOT="${PG_TEST_ROOT:-${OPENCLAW_REVIEW_ROOT:-${TMPDIR:-/tmp}}}"
    exec python3 "$ROOT/scripts/qa/home-latest-rls-plan.py"
  fi
done
# GitHub ubuntu runners provide Docker. Install only Python inside the disposable
# PG17 container; run initdb unprivileged and mount the checkout read-only.
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  exec docker run --rm --network bridge -v "$ROOT:/repo:ro" --entrypoint bash postgres:17-bookworm -euc '
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends python3 >/dev/null
    exec runuser -u postgres -- env PGBIN=/usr/lib/postgresql/17/bin python3 /repo/scripts/qa/home-latest-rls-plan.py
  '
fi
echo 'FAIL: PostgreSQL 17 or Docker required; regression gate was not executed' >&2
exit 1
