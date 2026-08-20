#!/usr/bin/env bash
set -euo pipefail

# Fixture-only contract mutations. The TypeScript entrypoint returns before roster/API loading,
# so this selftest performs no network access and does not re-run the 331-case live gate.
QA_TEAM_CONTRACT_SELFTEST=1 npm run qa:team-fullname-routing:core
