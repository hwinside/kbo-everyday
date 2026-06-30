import Capacitor
import StoreKit
import UIKit

/// 인앱 앱스토어 리뷰 요청 — StoreKit `SKStoreReviewController`.
/// Apple이 연 3회까지만 실제 노출하도록 자체 제한한다(우리는 "좋은 순간에 1회" 요청만 책임).
/// JS(`native-app-review.ts`)가 앱 실행 10회 이상 + 홈 진입 시 1회 호출.
@objc(AppReviewPlugin)
public class AppReviewPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppReviewPlugin"
    public let jsName = "AppReview"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestReview", returnType: CAPPluginReturnPromise),
    ]

    @objc func requestReview(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if #available(iOS 14.0, *),
               let scene = UIApplication.shared.connectedScenes
                   .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene {
                SKStoreReviewController.requestReview(in: scene)
            } else {
                SKStoreReviewController.requestReview()
            }
            call.resolve()
        }
    }
}
