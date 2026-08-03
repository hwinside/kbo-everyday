#!/usr/bin/env bash
# baseline + mutation self-guard.
# Chromium이 없는 환경(Vercel prebuild)에서는 baseline script가 SKIP/FAIL을 스스로 판정하므로
# mutation 루프를 돌리지 않는다. mutation은 Chromium이 있을 때만 fail-closed로 검증된다.
set -euo pipefail

node scripts/qa/post-detail-header-nowrap-browser.mjs

if ! node -e '
const { existsSync } = require("node:fs");
const path = require("playwright").chromium.executablePath();
process.exit(path && existsSync(path) ? 0 : 1);
'; then
  echo "SKIP: chromium 없음 — mutation self-guard 생략 (browser 게이트는 community-profile-ui GHA가 fail-closed 실행)"
  exit 0
fi

for mutation in \
  POST_HEADER_MUTATE_COMMENT_INDENT \
  POST_HEADER_MUTATE_PROFILE_SOURCE \
  POST_HEADER_MUTATE_RAW_AVATAR \
  POST_HEADER_MUTATE_PROPAGATION \
  POST_HEADER_MUTATE_DETAIL_WRAP \
  POST_HEADER_MUTATE_PROFILE_ROUTE
do
  if env "$mutation=1" POST_HEADER_REQUIRE_BROWSER=1 node scripts/qa/post-detail-header-nowrap-browser.mjs; then
    echo "FAIL: $mutation did not make the browser gate RED"
    exit 1
  fi
  echo "RED confirmed: $mutation"
done
