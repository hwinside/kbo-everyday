import UIKit
import UserNotifications

/// Single-window UIScene entry point. Keep AppDelegate's existing URL allowlist,
/// Facebook/Capacitor forwarding and native foreground work as the shared handlers.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    private var appDelegate: AppDelegate? {
        UIApplication.shared.delegate as? AppDelegate
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // Scene apps receive notification-tap cold starts here, not in launchOptions.
        // A response is a user action; silent background delivery never enters this path.
        if let response = connectionOptions.notificationResponse,
           response.actionIdentifier != UNNotificationDismissActionIdentifier,
           let url = response.notification.request.content.userInfo["url"] as? String {
            PushDeepLinkPlugin.stash(url: url)
        }

        let window = UIWindow(windowScene: windowScene)
        // Preserve all app-specific plugin registrations (not plain CAPBridgeViewController).
        let controller = MainViewController()
        window.rootViewController = controller
        self.window = window
        appDelegate?.window = window
        // Register native listeners before forwarding cold OAuth/Universal Links.
        controller.loadViewIfNeeded()
        window.makeKeyAndVisible()

        self.scene(scene, openURLContexts: connectionOptions.urlContexts)
        for activity in connectionOptions.userActivities {
            self.scene(scene, continue: activity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            var options: [UIApplication.OpenURLOptionsKey: Any] = [
                .openInPlace: context.options.openInPlace
            ]
            if let source = context.options.sourceApplication {
                options[.sourceApplication] = source
            }
            if let annotation = context.options.annotation {
                options[.annotation] = annotation
            }
            _ = appDelegate?.application(UIApplication.shared, open: context.url, options: options)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = appDelegate?.application(UIApplication.shared, continue: userActivity,
                                    restorationHandler: { _ in })
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        appDelegate?.applicationWillEnterForeground(UIApplication.shared)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        appDelegate?.applicationDidBecomeActive(UIApplication.shared)
    }

    // UIKit still posts UIApplication lifecycle notifications for this single-scene
    // app. Do not repost them: Capacitor 8.3/App 8.1 already observe those notifications.
}
