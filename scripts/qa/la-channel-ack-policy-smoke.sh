#!/usr/bin/env bash
# Broadcast 채널 ACK 정책 회귀 스모크 (삼순 PR #663 회귀 기준 3건 고정)
# ChannelAckPolicy.swift(앱 타깃과 동일 소스)를 그대로 컴파일해 실행한다. macOS/swiftc 필요.
set -euo pipefail
cd "$(dirname "$0")/../.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
swiftc -o "$out/la-ack-policy" \
  ios/App/App/ChannelAckPolicy.swift \
  scripts/qa/la-channel-ack-policy-smoke.swift
"$out/la-ack-policy"
