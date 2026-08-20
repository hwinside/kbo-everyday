#!/usr/bin/env bash
set -euo pipefail

run_red() {
  local fault="$1" expected="$2" log
  log="$(mktemp "${TMPDIR:-/tmp}/team-snapshot-${fault}.XXXXXX")"
  trap 'rm -f "$log"' RETURN
  if QA_TEAM_SNAPSHOT_FAULT="$fault" npm run qa:team-fullname-routing:core >"$log" 2>&1; then
    echo "❌ $fault: gate unexpectedly GREEN" >&2
    tail -20 "$log" >&2
    return 1
  fi
  if ! grep -Fq "$expected" "$log"; then
    echo "❌ $fault: failed for the wrong reason (expected: $expected)" >&2
    tail -20 "$log" >&2
    return 1
  fi
  echo "✅ $fault RED: $expected"
}

run_red missing_wins "필드 'wins' 결손"
run_red missing_batting "batting 배열 결손"
echo "✅ team snapshot contract selftest: 2/2 RED"
