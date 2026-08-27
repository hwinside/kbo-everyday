import Capacitor
import Foundation
import Security

/// 세션 토큰 백업 전용 Keychain 브릿지 — WKWebView 웹 저장소 퍼지 대응 (PR #1265).
///
/// - 저장소: iOS Keychain(kSecClassGenericPassword). WKWebsiteDataStore 퍼지와 무관하고
///   UserDefaults 평문 저장(P0 보안 NO-GO 축)을 피한다.
/// - 접근성: afterFirstUnlockThisDeviceOnly — 잠금 해제 후 백그라운드 접근 가능,
///   기기 밖(iCloud/백업 복원 타 기기)으로는 나가지 않는다.
/// - Keychain은 Apple required-reason API 목록에 없어 PrivacyInfo.xcprivacy 사유 등재가
///   필요 없다 (UserDefaults 계열을 쓰지 않는 이유 중 하나).
@objc(SecureSessionStorePlugin)
public class SecureSessionStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureSessionStorePlugin"
    public let jsName = "SecureSessionStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeIfValueMatches", returnType: CAPPluginReturnPromise),
    ]

    /// 읽기-비교-삭제의 원자성 보장 직렬 큐 (삼순 4차: 네이티브 원자적 compare-and-delete).
    /// 모든 쓰기 경로(set/remove/removeIfValueMatches)가 같은 큐를 타서
    /// CAS 의 비교↔삭제 사이에 다른 쓰기가 끼어들 수 없다.
    private let storeQueue = DispatchQueue(label: "fan.keubo.secure-session-store.queue")

    private let service = "fan.keubo.secure-session-store"

    /// 설치 생명주기 게이트 통과 여부. false 면 fail-close:
    /// get 은 항상 null(잔존 계정 비노출), set/remove 는 reject.
    private var storeReady = false

    /// 설치 생명주기 계약(삼순 2차 NO-GO ② + 3차 iOS P0): 업데이트=유지 / 재설치=삭제 / WebView 퍼지=복원.
    /// iOS Keychain 은 앱 삭제 후에도 남을 수 있어 재설치 시 이전 계정이 부활할 수 있다.
    /// Library 의 first-install marker 파일로 판정하되(UserDefaults 미사용 — required-reason
    /// 회피), 의사결정은 전부 SecureSessionStoreInstallGate 순수 함수가 담당한다
    /// (scripts/qa/native-session-backup-installgate.swift 가 삭제 실패·marker 생성 실패를
    /// 실제 실행으로 주입 검증):
    /// - 삭제 실패 → marker 미생성(다음 실행 재시도) + ready=false → 잔존 계정 복원 불가.
    /// - marker 생성 실패 → ready=false → set 거부라 "매 실행 wipe"는 빈 저장소 no-op.
    override public func load() {
        storeReady = evaluateInstallLifecycle()
    }

    private var installMarkerURL: URL? {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first?
            .appendingPathComponent("fan.keubo.secure-session-store.installed")
    }

    private func evaluateInstallLifecycle() -> Bool {
        guard let marker = installMarkerURL else { return false }
        let markerExists = FileManager.default.fileExists(atPath: marker.path)
        if markerExists {
            // 업데이트/재실행 — 유지
            return SecureSessionStoreInstallGate.isReady(
                markerExists: true, deleteStatus: errSecSuccess, markerCreated: false)
        }
        // 신규 또는 재설치 — 잔존 Keychain 항목 전부 삭제 시도, 결과를 버리지 않고 판정에 사용
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        let deleteStatus = SecItemDelete(query as CFDictionary)
        var markerCreated = false
        if SecureSessionStoreInstallGate.shouldCreateMarker(
            markerExists: false, deleteStatus: deleteStatus) {
            markerCreated = FileManager.default.createFile(atPath: marker.path, contents: Data())
                && FileManager.default.fileExists(atPath: marker.path)
            if markerCreated {
                // marker 백업 제외(삼순 3차) — best-effort. 실패해도 타기기 복원 시
                // Keychain(ThisDeviceOnly)은 이전되지 않아 계정 부활 경로는 없다(심층방어).
                var mutableMarker = marker
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? mutableMarker.setResourceValues(values)
            }
        }
        return SecureSessionStoreInstallGate.isReady(
            markerExists: false, deleteStatus: deleteStatus, markerCreated: markerCreated)
    }

    private func baseQuery(key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key is required")
            return
        }
        guard storeReady else {
            // fail-close: wipe 미확정 상태에서 잔존 계정을 절대 노출하지 않는다
            call.resolve(["value": NSNull()])
            return
        }
        storeQueue.async { [weak self] in
            guard let self else { return }
            switch self.readValue(key: key) {
            case .found(let value): call.resolve(["value": value])
            case .notFound: call.resolve(["value": NSNull()])
            case .failure(let status): call.reject("keychain get failed: \(status)")
            }
        }
    }

    private enum ReadResult {
        case found(String)
        case notFound
        case failure(OSStatus)
    }

    /// storeQueue 위에서만 호출할 것.
    private func readValue(key: String) -> ReadResult {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data,
           let value = String(data: data, encoding: .utf8) {
            return .found(value)
        }
        if status == errSecItemNotFound { return .notFound }
        return .failure(status)
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty,
              let value = call.getString("value") else {
            call.reject("key and value are required")
            return
        }
        guard storeReady else {
            call.reject("store not ready (install lifecycle gate)")
            return
        }
        guard let data = value.data(using: .utf8) else {
            call.reject("value encoding failed")
            return
        }

        storeQueue.async { [weak self] in
            guard let self else { return }
            // upsert: 삭제 후 추가 (SecItemUpdate 분기보다 단순·결정적)
            SecItemDelete(self.baseQuery(key: key) as CFDictionary)
            var attrs = self.baseQuery(key: key)
            attrs[kSecValueData as String] = data
            attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(attrs as CFDictionary, nil)
            if status == errSecSuccess {
                call.resolve()
            } else {
                call.reject("keychain set failed: \(status)")
            }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key is required")
            return
        }
        guard storeReady else {
            call.reject("store not ready (install lifecycle gate)")
            return
        }
        storeQueue.async { [weak self] in
            guard let self else { return }
            let status = SecItemDelete(self.baseQuery(key: key) as CFDictionary)
            if status == errSecSuccess || status == errSecItemNotFound {
                call.resolve()
            } else {
                call.reject("keychain remove failed: \(status)")
            }
        }
    }

    /// 원자적 compare-and-delete (삼순 4차): 저장된 값이 expectedValue 와 일치할 때만 삭제.
    /// 비교↔삭제가 storeQueue 직렬 안에서 실행돼 그 사이 set 이 끼어들 수 없다 —
    /// 늦은 확정 refresh 거부가 rotation 된 새 백업을 지우는 윈도우를 원천 제거.
    /// 반환: { removed: Bool } — 불일치/부재는 removed=false 로 정상 resolve.
    @objc func removeIfValueMatches(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty,
              let expected = call.getString("expectedValue") else {
            call.reject("key and expectedValue are required")
            return
        }
        guard storeReady else {
            call.reject("store not ready (install lifecycle gate)")
            return
        }
        storeQueue.async { [weak self] in
            guard let self else { return }
            switch self.readValue(key: key) {
            case .found(let current):
                if current == expected {
                    let status = SecItemDelete(self.baseQuery(key: key) as CFDictionary)
                    if status == errSecSuccess || status == errSecItemNotFound {
                        call.resolve(["removed": true])
                    } else {
                        call.reject("keychain remove failed: \(status)")
                    }
                } else {
                    call.resolve(["removed": false])
                }
            case .notFound:
                call.resolve(["removed": false])
            case .failure(let status):
                call.reject("keychain get failed: \(status)")
            }
        }
    }
}
