#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${OPENCLAW_REVIEW_ROOT:?Set a review-root path for native QA artifacts}"
out="$(mktemp -d "$OPENCLAW_REVIEW_ROOT/la-recovery-qa.XXXXXX")"
swiftc -o "$out/normal" ios/App/App/ChannelAckPolicy.swift ios/App/App/ChannelMigrationPolicy.swift scripts/qa/la-recovery-card-policy-smoke.swift
"$out/normal"
# Same compiled production policy; removing retry preference must fail each ordering.
sed 's/if lhsRetry != rhsRetry { return lhsRetry }/if lhsRetry != rhsRetry { return !lhsRetry }/' ios/App/App/ChannelMigrationPolicy.swift > "$out/mutant.swift"
swiftc -o "$out/mutant" ios/App/App/ChannelAckPolicy.swift "$out/mutant.swift" scripts/qa/la-recovery-card-policy-smoke.swift
if "$out/mutant" > "$out/mutant.log" 2>&1; then
  echo "FAIL retry-preference mutation survived"; exit 1
fi
echo "PASS retry-preference mutation RED; artifacts: $out"

python3 scripts/qa/la-recovery-caller-smoke.py "$out"
