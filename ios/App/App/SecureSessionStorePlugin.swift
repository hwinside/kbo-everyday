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
