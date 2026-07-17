//
//  WatchSyncManager.swift
//  최애팀 코드를 페어링된 애플워치로 동기화(WCSession applicationContext).
//
//  워치 컴플리케이션이 최애팀 경기를 고르는 유일한 입력이 이 값이다. applicationContext는
//  최신값 1개만 유지되고 워치 미도달 시 시스템이 보관·재전달하므로, 앱 실행 시 1회 +
//  팀 변경 시(setMyTeam)마다 push하면 충분하다. 워치 미페어링/앱 미설치면 조용히 no-op.
//

import Foundation
import WatchConnectivity

final class WatchSyncManager: NSObject, WCSessionDelegate {
    static let shared = WatchSyncManager()
    private override init() { super.init() }

    private var pendingCode: String?

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    func syncMyTeam(_ code: String) {
        guard WCSession.isSupported(), !code.isEmpty else { return }
        let session = WCSession.default
        guard session.activationState == .activated else {
            pendingCode = code
            return
        }
        try? session.updateApplicationContext(["my_team": code])
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        guard activationState == .activated else { return }
        // 활성화 전 요청분 우선, 없으면 저장된 최애팀을 1회 push(앱 시작 경로).
        let code = pendingCode
            ?? UserDefaults(suiteName: WidgetSnapshotStore.appGroupId)?.string(forKey: "my_team")
            ?? ""
        pendingCode = nil
        if !code.isEmpty {
            try? session.updateApplicationContext(["my_team": code])
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        // 워치 전환(다른 워치로 페어링 변경) 시 재활성화 — Apple 권장 패턴.
        session.activate()
    }
}
