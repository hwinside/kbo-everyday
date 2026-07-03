import UIKit
import Capacitor
import FBSDKCoreKit
import AppTrackingTransparency

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Facebook SDK 초기화 (Meta App Events) — 런치 시점에 먼저 부트스트랩.
        ApplicationDelegate.shared.application(application, didFinishLaunchingWithOptions: launchOptions)
        // Live Activity observer를 *네이티브 부팅 시점*에 시작(웹뷰/Capacitor 플러그인 의존 제거).
        // push-to-start로 앱이 백그라운드 launch될 때도 update/push-to-start 토큰을 잡아
        // register-device로 등록 → 앱을 한 번도 열지 않아도 카드가 갱신된다. (본 fix 핵심)
        if #available(iOS 16.1, *) {
            LiveActivityController.shared.startObservers()
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // 조건2 보강 — 포그라운드 복귀 시 persist된 push-to-start 토큰을 register-start로 재등록
        // (백그라운드 rotate분 서버 매핑 최신화). 자세한 내용은 LiveActivityController 참조.
        if #available(iOS 16.1, *) {
            LiveActivityController.shared.resyncPushToStartTokenOnForeground()
            // 앱 열 때마다 살아있는 카드를 재-enumerate해 update 토큰을 확보한다. 백그라운드
            // suspend 중 뜬 push-to-start 카드(예정 30분 전)를 다음 포그라운드에 반드시 잡아
            // "하루에 여러 번 앱을 여는데도 카드가 얼어붙는" 프리즈를 없앤다(하린아빠 사례).
            LiveActivityController.shared.rescanActiveActivities()
        }
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // ATT 권한 상태를 Meta SDK(advertiserTrackingEnabled)에 *먼저* 반영한 뒤
        // App Activate 이벤트를 보낸다. Meta ATE는 이벤트 전 상태 반영이 원칙이므로,
        // activateApp() 호출은 syncAdvertiserTracking 내부에서 ATE 반영 직후 수행한다.
        syncAdvertiserTracking()
    }

    /// App Tracking Transparency 상태를 Meta SDK에 반영한 뒤 App Activate 이벤트를 전송.
    /// - iOS 14+: ATT 권한이 .notDetermined면 앱이 active일 때 프롬프트를 띄우고(약간의 지연으로 UI 표시 보장),
    ///   결정 결과를 `Settings.shared.isAdvertiserTrackingEnabled`에 반영한 *직후* activateApp()을 호출한다.
    /// - 이미 결정된 상태면 ATE 플래그를 갱신한 뒤 곧바로 activateApp()을 호출한다(프롬프트 재노출 없음).
    /// - 권한 거부/제한 시에도 SKAdNetwork/AEM(앱 취합 이벤트 측정)은 동작하므로 설치 캠페인 측정은 유지된다.
    private func syncAdvertiserTracking() {
        guard #available(iOS 14, *) else {
            Settings.shared.isAdvertiserTrackingEnabled = true
            AppEvents.shared.activateApp()
            return
        }
        let status = ATTrackingManager.trackingAuthorizationStatus
        if status == .notDetermined {
            // 프롬프트는 앱이 foreground active일 때만 표시된다. 첫 프레임이 그려진 뒤 띄우기 위해 잠깐 지연.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                ATTrackingManager.requestTrackingAuthorization { newStatus in
                    Settings.shared.isAdvertiserTrackingEnabled = (newStatus == .authorized)
                    // ATE 상태를 반영한 직후 App Activate 이벤트 전송.
                    AppEvents.shared.activateApp()
                }
            }
        } else {
            Settings.shared.isAdvertiserTrackingEnabled = (status == .authorized)
            AppEvents.shared.activateApp()
        }
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        let facebookHandled = ApplicationDelegate.shared.application(
            app,
            open: url,
            sourceApplication: options[.sourceApplication] as? String,
            annotation: options[.annotation]
        )
        return facebookHandled || ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // MARK: - Push Notifications (@capacitor-firebase/messaging)

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        NotificationCenter.default.post(name: Notification.Name.init("didReceiveRemoteNotification"), object: completionHandler, userInfo: userInfo)
    }

}
