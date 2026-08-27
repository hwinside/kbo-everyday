#!/usr/bin/env bash
# iOS 설치 생명주기 게이트 실패 주입 회귀 — 순수 함수를 swiftc로 컴파일해 실제 실행.
# (macOS 전용 — Security 프레임워크 필요. CI 리눅스에서는 skip 처리)
set -euo pipefail
cd "$(dirname "$0")/../.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "SKIP — swiftc 없음 (macOS 전용 게이트)"
  exit 0
fi
WORK="$(mktemp -d)"
# swiftc는 top-level 실행문을 main.swift에서만 허용 → 테스트를 main.swift로 복사해 컴파일
cp scripts/qa/native-session-backup-installgate.swift "$WORK/main.swift"
swiftc -o "$WORK/installgate" ios/App/App/SecureSessionStoreInstallGate.swift "$WORK/main.swift"
"$WORK/installgate"
