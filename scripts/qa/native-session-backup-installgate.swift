// native-session-backup-installgate — iOS 설치 생명주기 게이트 실패 주입 회귀.
//
// 대상: ios/App/App/SecureSessionStoreInstallGate.swift (순수 함수 — Capacitor 비의존)
// 실행: npm run qa:native-session-backup:installgate
//   (swiftc 로 게이트 파일과 이 테스트를 함께 컴파일해 macOS 에서 실제 실행)
//
// 삼순 3차 NO-GO iOS P0 계약:
// - Keychain 삭제 실패 → marker 미생성(다음 실행 재시도) + ready=false (잔존 계정 비노출)
// - marker 생성 실패 → ready=false (set 거부 → "매 실행 wipe"는 빈 저장소 no-op)
// - 삭제 success/itemNotFound + marker 생성 성공 → ready
// - marker 존재(업데이트/재실행) → wipe 없이 ready

import Foundation
import Security

var failures = 0
func check(_ name: String, _ cond: Bool) {
    if cond {
        print("  ✅ \(name)")
    } else {
        failures += 1
        print("  ❌ \(name)")
    }
}

let failStatus: OSStatus = errSecInteractionNotAllowed // 삭제 실패 주입 대표값
let ioErr: OSStatus = errSecIO

print("[1] wipe 확정 판정")
check("errSecSuccess → 확정", SecureSessionStoreInstallGate.wipeConfirmed(deleteStatus: errSecSuccess))
check("errSecItemNotFound → 확정", SecureSessionStoreInstallGate.wipeConfirmed(deleteStatus: errSecItemNotFound))
check("errSecInteractionNotAllowed → 미확정", !SecureSessionStoreInstallGate.wipeConfirmed(deleteStatus: failStatus))
check("errSecIO → 미확정", !SecureSessionStoreInstallGate.wipeConfirmed(deleteStatus: ioErr))

print("[2] 삭제 실패 주입 → marker 미생성 + ready=false (재시도 보존·잔존 계정 비노출)")
check("marker 생성 시도 안 함",
      !SecureSessionStoreInstallGate.shouldCreateMarker(markerExists: false, deleteStatus: failStatus))
check("ready=false",
      !SecureSessionStoreInstallGate.isReady(markerExists: false, deleteStatus: failStatus, markerCreated: false))
check("ready=false (marker 가 어찌됐든 생겼어도 삭제 미확정이면 불가)",
      !SecureSessionStoreInstallGate.isReady(markerExists: false, deleteStatus: failStatus, markerCreated: true))

print("[3] marker 생성 실패 주입 → ready=false")
check("삭제 성공+marker 실패 → ready=false",
      !SecureSessionStoreInstallGate.isReady(markerExists: false, deleteStatus: errSecSuccess, markerCreated: false))
check("삭제 itemNotFound+marker 실패 → ready=false",
      !SecureSessionStoreInstallGate.isReady(markerExists: false, deleteStatus: errSecItemNotFound, markerCreated: false))

print("[4] 정상 경로")
check("신규 설치: 삭제 success + marker 성공 → ready",
      SecureSessionStoreInstallGate.isReady(markerExists: false, deleteStatus: errSecSuccess, markerCreated: true))
check("신규 설치: itemNotFound + marker 성공 → ready",
      SecureSessionStoreInstallGate.isReady(markerExists: false, deleteStatus: errSecItemNotFound, markerCreated: true))
check("marker 부재+삭제 확정 → marker 생성 시도",
      SecureSessionStoreInstallGate.shouldCreateMarker(markerExists: false, deleteStatus: errSecSuccess))

print("[5] 업데이트/재실행 (marker 존재) → wipe 없이 ready")
check("marker 존재 → ready", SecureSessionStoreInstallGate.isReady(markerExists: true, deleteStatus: failStatus, markerCreated: false))
check("marker 존재 → 생성 시도 안 함", !SecureSessionStoreInstallGate.shouldCreateMarker(markerExists: true, deleteStatus: errSecSuccess))

print("")
if failures > 0 {
    print("FAIL — \(failures)건")
    exit(1)
}
print("PASS — 전 케이스 통과")
