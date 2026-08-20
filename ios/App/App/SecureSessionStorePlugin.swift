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
    ]

    private let service = "fan.keubo.secure-session-store"

    /// 설치 생명주기 계약(삼순 2차 NO-GO ②): 업데이트=유지 / 재설치=삭제 / WebView 퍼지=복원.
    /// iOS Keychain 은 앱 삭제 후에도 남을 수 있어, 그대로 두면 재설치 시 이전 계정이
    /// 자동 부활한다. 앱 샘드박스 Library 디렉토리(삭제 시 확실히 증발)에 first-install
    /// marker 파일을 두고, 부팅 시 marker 가 없으면(=신규/재설치) 이 서비스의 Keychain
    /// 항목을 전부 지운 뒤 marker 를 생성한다. (UserDefaults 를 쓰지 않는 이유:
    /// required-reason API 라 PrivacyInfo 사유 등재가 필요해짐 — 파일 존재 확인은 무관)
    override public func load() {
        wipeOnFreshInstall()
    }

    private var installMarkerURL: URL? {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first?
            .appendingPathComponent("fan.keubo.secure-session-store.installed")
    }

    private func wipeOnFreshInstall() {
        guard let marker = installMarkerURL else { return }
        if FileManager.default.fileExists(atPath: marker.path) { return } // 업데이트/재실행 = 유지
        // 신규 또는 재설치 — 잔존 Keychain 항목 전부 삭제 (이전 계정 부활 차단)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
        FileManager.default.createFile(atPath: marker.path, contents: Data())
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
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data,
           let value = String(data: data, encoding: .utf8) {
            call.resolve(["value": value])
        } else if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
        } else {
            call.reject("keychain get failed: \(status)")
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty,
              let value = call.getString("value") else {
            call.reject("key and value are required")
            return
        }
        guard let data = value.data(using: .utf8) else {
            call.reject("value encoding failed")
            return
        }

        // upsert: 삭제 후 추가 (SecItemUpdate 분기보다 단순·결정적)
        SecItemDelete(baseQuery(key: key) as CFDictionary)
        var attrs = baseQuery(key: key)
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attrs as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("keychain set failed: \(status)")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key is required")
            return
        }
        let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("keychain remove failed: \(status)")
        }
    }
}
