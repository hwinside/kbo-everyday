//
//  KBOWatchApp.swift
//  크보팬 워치 앱 — 컴플리케이션(KBOWatchWidget) 컨테이너 + 최애팀 수신.
//
//  watchOS 위젯 익스텐션은 워치 앱에 임베드돼야 하므로 이 앱이 컨테이너 역할.
//  iPhone 앱이 WCSession applicationContext로 보내는 최애팀 코드를 App Group에 기록해
//  컴플리케이션이 읽게 한다(위젯 익스텐션은 WCSession을 직접 못 씀). Capacitor(WebView)
//  미사용 — 전부 네이티브 SwiftUI(원격로드 앱이라 워치에서 웹뷰 재사용 불가).
//

import SwiftUI
import WatchConnectivity
import WidgetKit

/// iPhone → 워치 최애팀 동기화 수신부. 앱이 한 번이라도 실행되면 이후 컨텍스트는
/// 백그라운드로도 전달·보관된다(applicationContext는 최신값 1개 유지).
final class WatchSessionStore: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchSessionStore()
    @Published var myTeamCode: String = WatchStore.loadMyTeam()

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        guard activationState == .activated else { return }
        apply(session.receivedApplicationContext)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        apply(applicationContext)
    }

    private func apply(_ context: [String: Any]) {
        guard let code = context["my_team"] as? String, !code.isEmpty,
              code != WatchStore.loadMyTeam() else { return }
        WatchStore.saveMyTeam(code)
        DispatchQueue.main.async { self.myTeamCode = code }
        WidgetCenter.shared.reloadAllTimelines()
    }
}

@main
struct KBOWatchApp: App {
    @StateObject private var session = WatchSessionStore.shared

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environmentObject(session)
                .onAppear { WatchSessionStore.shared.activate() }
        }
    }
}
