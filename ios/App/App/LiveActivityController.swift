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

    /// 실데이터로 Activity 시작/전환 (W2 경기룸 진입). 같은 gameId가 이미 떠 있으면
    /// 갱신만, 다른 gameId면 이전 종료 후 신규(v1 단일 경기). 앱 재시작으로
    /// currentActivity가 nil이어도 시스템에 살아있는 Activity를 회수해 중복 생성을
    /// 막는다 (삼순 W2-① 복구/중복방지).
    @discardableResult
    func start(
        gameId: String,
        awayTeam: String,
        homeTeam: String,
        awayTeamCode: String,
        homeTeamCode: String,
        state: KBOGameAttributes.ContentState
    ) async -> Bool {
        guard isEnabled else {
            NSLog("[LiveActivity] disabled in settings")
            return false
        }

        // 메모리엔 없지만 시스템에 살아있는 Activity 회수 (앱 재시작 대비)
        if currentActivity == nil {
            currentActivity = Activity<KBOGameAttributes>.activities.first
        }

        // 이미 같은 경기가 떠 있으면 갱신만 (재진입 중복 방지)
        if let existing = currentActivity {
            if existing.attributes.gameId == gameId {
                await existing.update(using: state)
                return true
            }
            // 다른 경기 진입 → 이전 Activity를 *완료까지 대기*하며 즉시 종료한 뒤 신규.
            // (await로 순차 — Task로 던지고 currentActivity=nil 하면 end가 no-op 돼
            //  이전 카드가 남는 문제, 삼순 W2 블로커). 전환은 즉시 dismiss(.immediate),
            //  15분 잔상은 경기 final 종료(W4)에만.
            await endCurrent(immediate: true)
        }

        let attributes = KBOGameAttributes(
            gameId: gameId,
            awayTeam: awayTeam,
            homeTeam: homeTeam,
            awayTeamCode: awayTeamCode,
            homeTeamCode: homeTeamCode
        )
        do {
            let activity = try Activity.request(
                attributes: attributes,
                contentState: state,
                pushType: nil   // W2는 로컬 update. W3에서 .token(APNs)로 전환
            )
            currentActivity = activity
            NSLog("[LiveActivity] started game=\(gameId) id=\(activity.id)")
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

    /// 종료(경기 final) — 최종 content-state + 15분 후 자동 제거(dismissal-date).
    func end(finalState: KBOGameAttributes.ContentState? = nil) async {
        await endCurrent(immediate: false, finalState: finalState)
    }

    /// 공통 종료 헬퍼. immediate=true면 즉시 제거(경기 전환), false면 now+15m 잔상(W4 final).
    private func endCurrent(immediate: Bool, finalState: KBOGameAttributes.ContentState? = nil) async {
        guard let activity = currentActivity else { return }
        let last = finalState ?? activity.contentState
        let policy: ActivityUIDismissalPolicy =
            immediate ? .immediate : .after(Date().addingTimeInterval(15 * 60))
        await activity.end(using: last, dismissalPolicy: policy)
        currentActivity = nil
        NSLog("[LiveActivity] ended (immediate=\(immediate))")
    }
    #else
    var isEnabled: Bool { false }
    @discardableResult func startDummyActivity() -> Bool { false }
    #endif
}
