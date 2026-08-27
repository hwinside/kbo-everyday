import Foundation
import Security

/// 설치 생명주기 wipe 의사결정 — 순수 함수 (PR #1265 삼순 3차 NO-GO iOS P0).
///
/// Capacitor 의존이 없어 macOS swiftc 단독 컴파일이 가능하고,
/// scripts/qa/native-session-backup-installgate.swift 가 실패 주입(삭제 실패·marker
/// 생성 실패)을 실제 실행으로 검증한다. 플러그인(load)은 이 함수만 사용한다.
///
/// 계약:
/// - marker 존재(업데이트/재실행) → ready, wipe 없음.
/// - marker 부재(신규/재설치) → Keychain wipe 가 success/itemNotFound 로 확인되고
///   marker 생성까지 성공했을 때만 ready.
/// - wipe 실패 → marker 를 만들지 않는다(다음 실행 재시도). ready=false 로 get 이
///   잔존 계정을 절대 노출하지 않는다 (fail-close).
/// - marker 생성 실패(저장공간 압박 등) → ready=false. set 이 거부되므로 "매 실행
///   wipe" 는 빈 저장소에 대한 no-op 이고, 원 증상(세션 소실) 재현 경로가 없다.
enum SecureSessionStoreInstallGate {
    /// Keychain 삭제 status 가 "잔존 데이터 없음 확정"인지 판정.
    static func wipeConfirmed(deleteStatus: OSStatus) -> Bool {
        return deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound
    }

    /// marker 부재 시 marker 생성을 시도해야 하는지 = wipe 확정 이후에만.
    static func shouldCreateMarker(markerExists: Bool, deleteStatus: OSStatus) -> Bool {
        if markerExists { return false }
        return wipeConfirmed(deleteStatus: deleteStatus)
    }

    /// 플러그인 활성(ready) 판정.
    /// - markerExists: 부팅 시 marker 파일 존재 여부
    /// - deleteStatus: marker 부재 시 수행한 SecItemDelete 결과 (marker 존재 시 무시)
    /// - markerCreated: marker 생성 성공 여부 (시도하지 않았으면 false)
    static func isReady(markerExists: Bool, deleteStatus: OSStatus, markerCreated: Bool) -> Bool {
        if markerExists { return true }
        return wipeConfirmed(deleteStatus: deleteStatus) && markerCreated
    }
}
