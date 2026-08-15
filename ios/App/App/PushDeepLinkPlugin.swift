import Foundation
import Capacitor

/// 푸시 탭 cold-start 딥링크 인계 플러그인.
///
/// iOS는 앱이 완전 종료된 상태에서 알림을 탭해 launch되면 웹뷰/브릿지가 아직 없어
/// JS `notificationActionPerformed` 이벤트가 유실될 수 있다(capacitor-firebase 고질 이슈,
/// upstream #244 계열). 특히 이 앱은 원격 로드(server.url=keubo.fan)라 웹 부팅이 네트워크
/// 의존이라 유실 창이 더 넓다 — 결과가 "알림 탭 → 홈만 뜸"(#cs 2026-08-15 제보).
///
/// 대응: AppDelegate가 launchOptions의 알림 payload `url`을 UserDefaults에 보관하고,
/// 웹(JS)이 부팅 후 `consume()`으로 1회 회수해 앱 내 라우팅한다.
/// warm(백그라운드) 탭은 기존 JS 리스너(retained event)가 그대로 처리한다.
@objc(PushDeepLinkPlugin)
public class PushDeepLinkPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PushDeepLinkPlugin"
    public let jsName = "PushDeepLink"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "consume", returnType: CAPPluginReturnPromise)
    ]

    private static let urlKey = "pendingPushDeepLinkUrl"
    private static let atKey = "pendingPushDeepLinkAt"
    /// launch → 웹 부팅(원격 로드) 지연 허용 창. 이보다 오래된 pending은 폐기해
    /// "예전에 탭한 알림"이 한참 뒤 일반 실행에 재적용되는 것을 막는다.
    private static let freshnessWindowSec: TimeInterval = 180

    /// AppDelegate(didFinishLaunching)에서 호출 — 알림 탭 launch payload의 앱 내 경로 보관.
    /// 앱 내 상대경로("/...")만 저장한다(외부 URL 딥링크 오남용 차단).
    static func stash(url: String) {
        guard url.hasPrefix("/"), !url.hasPrefix("//") else { return }
        let defaults = UserDefaults.standard
        defaults.set(url, forKey: urlKey)
        defaults.set(Date().timeIntervalSince1970, forKey: atKey)
    }

    /// 보관된 pending 딥링크를 1회 반환하고 비운다. 없거나 신선도 창을 넘겼으면 빈 객체.
    @objc func consume(_ call: CAPPluginCall) {
        let defaults = UserDefaults.standard
        let url = defaults.string(forKey: Self.urlKey)
        let at = defaults.double(forKey: Self.atKey)
        defaults.removeObject(forKey: Self.urlKey)
        defaults.removeObject(forKey: Self.atKey)

        var result = JSObject()
        if let url = url, url.hasPrefix("/"), !url.hasPrefix("//"),
           at > 0, Date().timeIntervalSince1970 - at <= Self.freshnessWindowSec {
            result["url"] = url
        }
        call.resolve(result)
    }
}
