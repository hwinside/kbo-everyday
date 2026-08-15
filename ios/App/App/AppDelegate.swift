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
        // 애플워치 최애팀 동기화 — 활성화 완료 시 저장된 my_team을 1회 push.
        WatchSyncManager.shared.activate()
        // 푸시 탭 cold-start 딥링크 — 앱이 완전 종료된 상태에서 알림을 탭해 launch되면
        // 웹뷰/브릿지가 아직 없어 JS notificationActionPerformed가 유실될 수 있다(고질 이슈).
        // launch payload의 url을 보관해 웹 부팅 후 PushDeepLink.consume()이 회수한다.
        // .background = 무음 푸시(content-available) 백그라운드 launch — 유저 탭이 아니므로 제외
        // (game_live 등 무음 wake payload에도 url이 실려 있어, 제외하지 않으면 나중에 유저가
        // 앱을 일반 실행했을 때 엉뚱한 경기 페이지로 튕긴다).
        if application.applicationState != .background,
           let remote = launchOptions?[.remoteNotification] as? [AnyHashable: Any],
           let url = remote["url"] as? String {
            PushDeepLinkPlugin.stash(url: url)
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
        // 레거시 LA → broadcast 채널 카드 마이그레이션 — *foreground-active에서만* (삼순 R2
        // blocker③: local Activity.request()는 foreground 시작 계약). didBecomeActive는
        // cold launch·백그라운드 복귀 모두 커버한다(willEnterForeground는 cold launch 미호출).
        if #available(iOS 16.1, *) {
            LiveActivityController.shared.migrateLegacyActivitiesOnForeground()
        }
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
        //
        // Live Activity 카드 탭 딥링크 — widgetURL(universal link)의 앱 내 경로를 pending에
        // 보관해 웹(native-push-deeplink)이 단일 경로로 소비한다. cold launch는 웹 부팅 후
        // consume()이, warm 복귀는 appStateChange(active) 재회수가 집는다.
        // /auth* 는 제외 — OAuth 콜백 universal link를 라우팅하면 세션 교환 플로우를 깨늈다
        // (appUrlOpen 리스너가 토큰 교환 전담). 루트("/")도 이동 무의미라 제외.
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
           let url = userActivity.webpageURL,
           let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           components.host == "keubo.fan" {
            let path = components.path
            if path.hasPrefix("/"), path != "/", !path.hasPrefix("/auth") {
                let query = components.query.map { "?\($0)" } ?? ""
                PushDeepLinkPlugin.stash(url: path + query)
            }
        }
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
        // Layer 2 — 무음(content-available)/일반 원격 알림으로 앱이 백그라운드에서 깨어난
        // 순간, 살아있는 Live Activity를 재-enumerate해 update 토큰을 등록한다(register-device).
        // push-to-start로 카드만 뜨고 앱이 안 열린 유저의 토큰 미등록 갭을 "앱을 열지 않고"
        // 메운다 — 서버가 경기 시작/진행 중 무음 wake 푸시를 보내면 이 경로가 토큰을 잡는다.
        // 멱등(observedActivityIds 중복가드) — 매 푸시마다 호출해도 이중 등록 없음.
        // ⚠️ silent wake 컨텍스트 — rescan은 토큰 재등록만 하며 local Activity.request()는
        // 0건이다(삼순 R2 blocker③ — 마이그레이션은 didBecomeActive 전용).
        // completionHandler는 건드리지 않는다(Capacitor/Firebase 메시징 플러그인이 호출).
        if #available(iOS 16.1, *) {
            LiveActivityController.shared.rescanActiveActivities()
            LiveActivityController.shared.resyncPushToStartTokenOnForeground()
        }
        // A안 — 경기 종료 무음 wake: iOS 홈위젯은 서버 푸시로 직접 갱신되지 않으므로, game_end로
        // 백그라운드에서 깨어난 이 순간 홈위젯 스냅샷을 최종 스코어로 종료 처리한다(프리즈된 LIVE
        // 카드 → '경기 종료 + 최종 스코어'). 현재 위젯이 이 경기(gameId)를 표시 중일 때만 반영.
        if let kind = userInfo["kind"] as? String, kind == "game_end",
           let gameId = userInfo["gameId"] as? String,
           let asStr = userInfo["w_as"] as? String,
           let hsStr = userInfo["w_hs"] as? String {
            WidgetSnapshotStore.markFinal(gameId: gameId,
                                          awayScore: Int(asStr) ?? 0,
                                          homeScore: Int(hsStr) ?? 0)
        }
        // 1.0.9 build 17 — iOS 홈위젯 무음 갱신: 점수 변화 무음 push로 깨어난 순간 위젯
        // 스냅샷을 갱신한다(현재 위젯이 이 경기 표시 중일 때만, 팀/최애팀/next 보존).
        // widget_live는 이 핸들러 전용 kind(다른 소비자 없음) — 처리 후 completionHandler를
        // 명시적으로 1회 호출하고 조기 반환한다(삼순 #674 blocker② — 현 플러그인은 completion을
        // 호출하지 않으므로 미호출 시 iOS가 silent push를 추가 throttle할 수 있음. 조기 반환이
        // 이중 호출 가능성도 차단).
        if let kind = userInfo["kind"] as? String, kind == "widget_live" {
            if let gameId = userInfo["gameId"] as? String,
               let asStr = userInfo["w_as"] as? String,
               let hsStr = userInfo["w_hs"] as? String {
                // 반환값 = 실제 적용 여부 — no-op(스냅샷 없음/다른 경기/final/역순 거부)이면
                // .noData로 보고해 silent-push 예산 신뢰를 지킨다(삼순 #674 재리뷰 blocker②).
                let applied = WidgetSnapshotStore.markLiveScore(
                    gameId: gameId,
                    awayScore: Int(asStr) ?? 0,
                    homeScore: Int(hsStr) ?? 0,
                    inning: Int(userInfo["w_inning"] as? String ?? "1") ?? 1,
                    isTopInning: (userInfo["w_istop"] as? String) == "1",
                    outs: Int(userInfo["w_outs"] as? String ?? "0") ?? 0,
                    onFirst: (userInfo["w_first"] as? String) == "1",
                    onSecond: (userInfo["w_second"] as? String) == "1",
                    onThird: (userInfo["w_third"] as? String) == "1",
                    pitcherName: userInfo["w_pitcher"] as? String ?? "",
                    batterName: userInfo["w_batter"] as? String ?? "",
                    lastPlay: userInfo["w_lastplay"] as? String ?? "",
                    eventMs: Double(userInfo["w_ev"] as? String ?? "") ?? 0
                )
                completionHandler(applied ? .newData : .noData)
            } else {
                completionHandler(.noData)
            }
            return
        }
        NotificationCenter.default.post(name: Notification.Name.init("didReceiveRemoteNotification"), object: completionHandler, userInfo: userInfo)
    }

}
