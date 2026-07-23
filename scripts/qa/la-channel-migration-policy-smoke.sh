#!/usr/bin/env bash
# 레거시 → broadcast 채널 마이그레이션 정책 회귀 스모크 (7/23 파서 장애발 P0 재발 방지)
# ChannelMigrationPolicy.swift(+의존 ChannelAckPolicy.swift, 앱 타깃과 동일 소스)를
# 그대로 컴파일해 실행한다. macOS/swiftc 필요.
set -euo pipefail
cd "$(dirname "$0")/../.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
swiftc -o "$out/la-migration-policy" \
  ios/App/App/ChannelAckPolicy.swift \
  ios/App/App/ChannelMigrationPolicy.swift \
  scripts/qa/la-channel-migration-policy-smoke.swift
"$out/la-migration-policy"
