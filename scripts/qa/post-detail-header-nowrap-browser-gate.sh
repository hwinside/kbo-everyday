#!/usr/bin/env bash
set -euo pipefail

node scripts/qa/post-detail-header-nowrap-browser.mjs

for mutation in \
  POST_HEADER_MUTATE_COMMENT_INDENT \
  POST_HEADER_MUTATE_PROFILE_SOURCE \
  POST_HEADER_MUTATE_RAW_AVATAR \
  POST_HEADER_MUTATE_PROPAGATION \
  POST_HEADER_MUTATE_DETAIL_WRAP
do
  if env "$mutation=1" node scripts/qa/post-detail-header-nowrap-browser.mjs; then
    echo "FAIL: $mutation did not make the browser gate RED"
    exit 1
  fi
  echo "RED confirmed: $mutation"
done
