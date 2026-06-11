//
//  LiveActivityController.swift
//  KBO 크보팬 — 메인 앱 타깃
//
//  Live Activity 시작/갱신/종료 헬퍼. W1에선 더미 데이터로 잠금화면 표시 검증용.
//  W2에서 경기룸 진입 시 game-live fetch 결과로 start, W3에서 update,
//  W4에서 final + dismissal-date end로 확장한다.
//
//  ⚠️ iOS 16.1+ 전용. 16.1 미만에서는 no-op.
//

import Foundation

#if canImport(ActivityKit)
import ActivityKit
#endif

@available(iOS 16.1, *)
final class LiveActivityController {

    static let shared = LiveActivityController()
    private init() {}

    #if canImport(ActivityKit)
    private var currentActivity: Activity<KBOGameAttributes>?

    /// Live Activity 사용 가능 여부(설정에서 꺼져 있을 수 있음).
    var isEnabled: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// W1 검증용 — 더미 경기 한 건을 잠금화면에 띄운다.
    @discardableResult
    func startDummyActivity() -> Bool {
        guard isEnabled else {
            NSLog("[LiveActivity] disabled in settings")
            return false
        }

        let attributes = KBOGameAttributes(
            gameId: "DUMMY-20260611-LGOB",
            awayTeam: "LG",
            homeTeam: "두산",
            awayTeamCode: "LG",
            homeTeamCode: "OB"
        )
        let initialState = KBOGameAttributes.ContentState(
            awayScore: 3,
            homeScore: 2,
            inning: 7,
            isTopInning: false,
            balls: 2,
            strikes: 1,
            outs: 1,
            onFirst: true,
            onSecond: false,
            onThird: true,
            pitcherName: "고우석",
            batterName: "양석환",
            status: .live
        )

        do {
            let activity = try Activity.request(
                attributes: attributes,
                contentState: initialState,
                pushType: nil   // W1은 로컬. W3에서 .token(APNs)로 전환
            )
            currentActivity = activity
            NSLog("[LiveActivity] started id=\(activity.id)")
            return true
        } catch {
            NSLog("[LiveActivity] start failed: \(error.localizedDescription)")
            return false
        }
    }

    /// 진행 중 Activity 상태 갱신(로컬). W3에서 push로 대체/병행.
    func update(_ state: KBOGameAttributes.ContentState) async {
        guard let activity = currentActivity else { return }
        await activity.update(using: state)
    }

    /// 종료 — 최종 content-state + 15분 후 자동 제거(dismissal-date).
    func end(finalState: KBOGameAttributes.ContentState? = nil) async {
        guard let activity = currentActivity else { return }
        let last = finalState ?? activity.contentState
        let dismissAt = Date().addingTimeInterval(15 * 60) // now + 15m
        await activity.end(
            using: last,
            dismissalPolicy: .after(dismissAt)
        )
        currentActivity = nil
        NSLog("[LiveActivity] ended, dismiss at \(dismissAt)")
    }
    #else
    var isEnabled: Bool { false }
    @discardableResult func startDummyActivity() -> Bool { false }
    #endif
}
