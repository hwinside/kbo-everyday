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
import WidgetKit

#if canImport(ActivityKit)
import ActivityKit
#endif

@available(iOS 16.1, *)
final class LiveActivityController {

    static let shared = LiveActivityController()
    private init() {}

    #if canImport(ActivityKit)
    private var currentActivity: Activity<KBOGameAttributes>?

    /// per-activity APNs push token 발급 콜백 (gameId, tokenHex). 플러그인이 JS로 전달.
    var onPushToken: ((String, String) -> Void)?
    /// 같은 Activity에 대한 중복 토큰 관찰 방지.
    private var observedActivityIds = Set<String>()

    /// push-to-start 토큰 발급 콜백 (tokenHex). W3b — 앱 미실행 자동 시작용. 플러그인이 JS로 전달.
    var onPushToStartToken: ((String) -> Void)?
    /// push-to-start 관찰 중복 설치 방지.
    private var pushToStartObserved = false
    /// 가장 최근 push-to-start 토큰(디바이스 단위). 네이티브가 update token을 *앱 포그라운드
    /// 없이* 서버 등록할 때 이 토큰을 신원 증명으로 실어 보낸다(register-device).
    private var latestPushToStartToken: String?

    /// 디바이스 단위 push-to-start 토큰을 관찰(iOS 17.2+). 활성 Activity가 없어도 발급되며,
    /// 서버는 이 토큰으로 최애팀 경기 시작 시 Activity를 원격 시작한다(W3b). 17.2 미만은 no-op.
    func observePushToStartToken() {
        guard !pushToStartObserved else { return }
        if #available(iOS 17.2, *) {
            pushToStartObserved = true
            Task {
                for await tokenData in Activity<KBOGameAttributes>.pushToStartTokenUpdates {
                    let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                    latestPushToStartToken = hex
                    onPushToStartToken?(hex)
                }
            }
        }
    }

    /// Activity의 push token 업데이트를 관찰해 콜백으로 흘려보낸다(W3 APNs 등록용).
    private func observePushToken(_ activity: Activity<KBOGameAttributes>, gameId: String) {
        guard !observedActivityIds.contains(activity.id) else { return }
        observedActivityIds.insert(activity.id)
        Task {
            for await tokenData in activity.pushTokenUpdates {
                let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                onPushToken?(gameId, hex)                                  // 포그라운드 JS 경로
                registerUpdateTokenNatively(gameId: gameId, pushToken: hex) // 백그라운드 네이티브 경로
            }
        }
    }

    /// per-activity update token을 *앱 포그라운드 없이* 서버에 등록한다(W3a 백그라운드 경로).
    /// WebView(JS) `/register`는 앱이 떠 있을 때만 동작 → push-to-start로 앱 닫힌 채 뜬
    /// 카드는 토큰 미등록으로 갱신이 안 되고 시작 스냅샷에 얼어붙는다. 유저 세션 대신 디바이스의
    /// push-to-start 토큰을 신원으로 실어 `register-device`에 직접 POST(서버가 user_id 역매핑).
    /// fire-and-forget — 실패해도 JS 경로가 백업이라 앱에 영향 없음. push-to-start 토큰이 아직
    /// 없으면(iOS 17.2 미만 등) skip하고 JS 경로에 위임한다.
    private func registerUpdateTokenNatively(gameId: String, pushToken: String) {
        guard let startToken = latestPushToStartToken else { return }
        guard let url = URL(string: "https://keubo.fan/api/live-activity/register-device") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = [
            "gameId": gameId,
            "pushToken": pushToken,
            "pushToStartToken": startToken,
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req).resume()
    }

    /// push-to-start 관찰 중복 설치 방지.
    private var activityUpdatesObserved = false

    /// 로컬·원격(push-to-start) 가리지 않고 *모든* Activity 생성을 관찰해 per-activity
    /// update 토큰을 W3a 등록 경로(`onPushToken`)로 흘려보낸다. W3b로 앱 미실행 중 OS가
    /// 원격 생성한 Activity는 로컬 start()를 안 거치므로, 이 관찰이 없으면 update 토큰이
    /// 서버에 등록되지 않아 카드가 시작 스냅샷에 얼어붙는다(삼순 W3b NO-GO ①). iOS 16.2+.
    func observeAllActivities() {
        guard !activityUpdatesObserved else { return }
        if #available(iOS 16.2, *) {
            activityUpdatesObserved = true
            Task {
                for await activity in Activity<KBOGameAttributes>.activityUpdates {
                    observePushToken(activity, gameId: activity.attributes.gameId)
                }
            }
        }
    }

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
            homeTeamCode: "OB",
            myTeamCode: "LG"
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
            stadium: "잠실",
            status: .live
        )

        do {
            let activity = try Activity.request(
                attributes: attributes,
                contentState: initialState,
                pushType: nil   // W1은 로컬. W3에서 .token(APNs)로 전환
            )
            currentActivity = activity
            writeWidgetSnapshot(attributes: attributes, state: initialState)
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
        myTeamCode: String,
        state: KBOGameAttributes.ContentState
    ) async -> Bool {
        guard isEnabled else {
            NSLog("[LiveActivity] disabled in settings")
            return false
        }

        // 시스템에 살아있는 *모든* Activity를 회수해 정리한다 (앱 재시작·더미 누적으로
        // 여러 장 남은 상태를 코드로 거둠 — `.activities.first` 하나만으론 정리 불가, 삼순 #220).
        // 같은 gameId의 첫 한 개만 보존(아래서 갱신), 나머지(다른 경기·중복·더미)는 즉시 종료.
        // 전환/중복 종료는 .immediate, 15분 잔상은 경기 final(W4)에만.
        var keep: Activity<KBOGameAttributes>? = nil
        for activity in Activity<KBOGameAttributes>.activities {
            if activity.attributes.gameId == gameId && keep == nil {
                keep = activity
            } else {
                await activity.end(using: activity.contentState, dismissalPolicy: .immediate)
            }
        }
        currentActivity = keep

        // 같은 경기가 이미 떠 있으면 갱신만 (재진입 중복 방지)
        if let existing = currentActivity {
            await existing.update(using: state)
            observePushToken(existing, gameId: gameId)   // 앱 재시작 복구분도 토큰 재관찰
            writeWidgetSnapshot(attributes: existing.attributes, state: state)
            return true
        }

        let attributes = KBOGameAttributes(
            gameId: gameId,
            awayTeam: awayTeam,
            homeTeam: homeTeam,
            awayTeamCode: awayTeamCode,
            homeTeamCode: homeTeamCode,
            myTeamCode: myTeamCode
        )
        do {
            let activity = try Activity.request(
                attributes: attributes,
                contentState: state,
                pushType: .token   // W3: APNs 토큰 발급 → 서버가 백그라운드 갱신 푸시
            )
            currentActivity = activity
            observePushToken(activity, gameId: gameId)
            writeWidgetSnapshot(attributes: attributes, state: state)
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
        writeWidgetSnapshot(attributes: activity.attributes, state: state)
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
        // 종료 시에도 홈 위젯엔 최종 스코어 스냅샷을 남긴다(최근 경기 표시). 다음 경기
        // start나 빈 경기 진입 시 갱신/정리된다.
        writeWidgetSnapshot(attributes: activity.attributes, state: last)
        NSLog("[LiveActivity] ended (immediate=\(immediate))")
    }

    // MARK: - 홈 화면 위젯(KBOHomeWidget) 공유 스냅샷
    //
    // 앱 ↔ Widget Extension은 App Group(group.fan.keubo.app) UserDefaults로 통신한다.
    // Live Activity가 start/update/end될 때마다 현재 경기 스냅샷을 JSON으로 기록하고
    // WidgetCenter.reloadAllTimelines()로 위젯을 즉시 갱신한다. (안드로이드
    // GameNotificationPlugin.updateWidget의 iOS판)

    private func writeWidgetSnapshot(attributes: KBOGameAttributes,
                                     state: KBOGameAttributes.ContentState,
                                     hasGame: Bool = true) {
        let dict: [String: Any] = [
            "hasGame": hasGame,
            "gameId": attributes.gameId,
            "awayTeamCode": attributes.awayTeamCode,
            "homeTeamCode": attributes.homeTeamCode,
            "myTeamCode": attributes.myTeamCode,
            "awayScore": state.awayScore,
            "homeScore": state.homeScore,
            "inning": state.inning,
            "isTopInning": state.isTopInning,
            "outs": state.outs,
            "onFirst": state.onFirst,
            "onSecond": state.onSecond,
            "onThird": state.onThird,
            "pitcherName": state.pitcherName,
            "batterName": state.batterName,
            "stadium": state.stadium,
            "isFinal": state.isFinal,
            "status": state.isFinal ? "final" : "live",
            "startText": "",
            "dateText": "",
        ]
        WidgetSnapshotStore.write(dict)
    }
    #else
    var isEnabled: Bool { false }
    @discardableResult func startDummyActivity() -> Bool { false }
    #endif
}

// MARK: - 홈 위젯 스냅샷 공용 store
//
// 앱(LiveActivityController) ↔ JS 브리지(LiveActivityPlugin.writeWidgetSnapshot) 둘 다
// 이 store로 App Group에 기록한다. ActivityKit/16.1 비의존(WidgetKit은 iOS 14+) — 예정
// 경기 fallback 스냅샷은 Live Activity 없이도 기록돼야 하므로 별도 타입으로 분리한다.

enum WidgetSnapshotStore {
    static let appGroupId = "group.fan.keubo.app"
    static let key = "kbo_widget_snapshot"

    static func write(_ dict: [String: Any]) {
        guard let ud = UserDefaults(suiteName: appGroupId) else { return }
        if let data = try? JSONSerialization.data(withJSONObject: dict) {
            ud.set(data, forKey: key)
        }
        WidgetCenter.shared.reloadAllTimelines()
    }
}
