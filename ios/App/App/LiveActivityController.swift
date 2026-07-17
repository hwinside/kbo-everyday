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
import UIKit

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
    /// 조건1: App Group(UserDefaults)에 persist — 메모리 fallback 금지. 백그라운드 launch
    /// (웹뷰 미기동·프로세스 신규)에서도 register-device 신원으로 읽혀야 하므로 영속화한다.
    private static let pushToStartTokenKey = "kbo_push_to_start_token"
    private var latestPushToStartToken: String? {
        get { UserDefaults(suiteName: WidgetSnapshotStore.appGroupId)?.string(forKey: Self.pushToStartTokenKey) }
        set {
            guard let ud = UserDefaults(suiteName: WidgetSnapshotStore.appGroupId) else { return }
            if let v = newValue { ud.set(v, forKey: Self.pushToStartTokenKey) }
            else { ud.removeObject(forKey: Self.pushToStartTokenKey) }
        }
    }

    /// blocker fix(삼순 조건부 GO) — push-to-start 토큰이 아직 persist되지 않은 시점에 update
    /// token이 먼저 yield되면 register-device가 skip된다. 백그라운드 launch에서 update token
    /// 관찰(`observeAllActivities`/`Activity.activities` enumerate)이 push-to-start persist
    /// (`observePushToStartToken`)보다 먼저 도는 실제 레이스 — 특히 1.0.1→1.0.2 업데이트 후
    /// 앱을 아직 안 연 유저는 App Group 토큰이 비어 있다. skip된 `(gameId, pushToken)`을 큐에
    /// 보관했다가 push-to-start 토큰 persist 직후 flush해서 *절대 유실되지 않게* 한다.
    /// gameId 키 dict — 같은 경기 최신 토큰만 유지(중복 register·무한 증가 방지). 서로 다른
    /// Task(pushTokenUpdates ↔ pushToStartTokenUpdates)에서 접근하므로 락으로 직렬화한다.
    private let pendingLock = NSLock()
    private var pendingUpdateTokens: [String: String] = [:]   // gameId → 최신 pushToken

    /// 디바이스 단위 push-to-start 토큰을 관찰. 활성 Activity가 없어도 발급되며,
    /// 서버는 이 토큰으로 최애팀 경기 시작 시 Activity를 원격 시작한다(W3b).
    /// ⚠️ iOS 18.0 게이트(기존 17.2) — 위젯 익스텐션의 ActivityConfiguration이 워치 Smart Stack
    /// 지원과 함께 iOS 18+로 올라가서, 17.x 기기가 토큰을 등록하면 서버 start 푸시가
    /// 렌더 불가능한 유령 activity를 만든다. 미만 버전은 no-op(서버 잔존 토큰은 400 정리).
    func observePushToStartToken() {
        guard !pushToStartObserved else { return }
        if #available(iOS 18.0, *) {
            pushToStartObserved = true
            Task {
                for await tokenData in Activity<KBOGameAttributes>.pushToStartTokenUpdates {
                    let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                    let rotated = latestPushToStartToken != nil && latestPushToStartToken != hex
                    latestPushToStartToken = hex   // 조건1·2: App Group 즉시 persist
                    flushPendingUpdateTokens()     // blocker fix: start token 없어서 큐잉된 update token 재등록(유실 금지)
                    onPushToStartToken?(hex)       // 조건2: JS multicast → 포그라운드 register-start 재등록
                    if rotated {
                        NSLog("[LiveActivity] push-to-start token rotated → persisted; JS re-register requested")
                    }
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
        guard let startToken = latestPushToStartToken else {
            // blocker fix: skip하지 않고 큐에 보관 → push-to-start persist 직후 flush(유실 금지).
            pendingLock.lock()
            pendingUpdateTokens[gameId] = pushToken   // 같은 경기 최신 토큰만
            let count = pendingUpdateTokens.count
            pendingLock.unlock()
            // 조건5: 토큰값 미로깅 — gameId/대기 카운트만.
            NSLog("[LiveActivity] register-device deferred: no push-to-start token yet, queued (game=\(gameId), pending=\(count))")
            return
        }
        guard let url = URL(string: "https://keubo.fan/api/live-activity/register-device") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [
            "gameId": gameId,
            "pushToken": pushToken,
            "pushToStartToken": startToken,
        ]
        // 앱 빌드 번호(CFBundleVersion) — 서버가 빌드별 LA payload(풀/슬림)를 분기하는 태그.
        if let buildStr = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
           let build = Int(buildStr) {
            body["appBuild"] = build
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        // 백그라운드 launch에서 POST 완료까지 잠깐 실행시간 확보(곧 suspend 방지).
        let app = UIApplication.shared
        var bgTask = UIBackgroundTaskIdentifier.invalid
        bgTask = app.beginBackgroundTask(withName: "la-register-device") {
            if bgTask != .invalid { app.endBackgroundTask(bgTask); bgTask = .invalid }
        }
        URLSession.shared.dataTask(with: req) { _, resp, err in
            // 조건5: 토큰값 미로깅 — 상태코드/에러 사유만.
            if let err = err {
                NSLog("[LiveActivity] register-device error: \(err.localizedDescription)")
            } else if let http = resp as? HTTPURLResponse {
                NSLog("[LiveActivity] register-device status=\(http.statusCode) (game=\(gameId))")
            }
            if bgTask != .invalid { app.endBackgroundTask(bgTask); bgTask = .invalid }
        }.resume()
    }

    /// blocker fix(삼순) — push-to-start 토큰 persist 직후 호출. start token 부재로 큐잉됐던
    /// update token을 register-device로 재시도한다(절대 유실 금지). 큐를 먼저 비우고 락 밖에서
    /// 재전송 — 이때 latestPushToStartToken은 방금 채워졌으므로 재큐잉되지 않는다(무한루프 없음).
    private func flushPendingUpdateTokens() {
        guard latestPushToStartToken != nil else { return }
        pendingLock.lock()
        let pending = pendingUpdateTokens
        pendingUpdateTokens.removeAll()
        pendingLock.unlock()
        guard !pending.isEmpty else { return }
        NSLog("[LiveActivity] flushing \(pending.count) deferred update token(s) after push-to-start persist")
        for (gameId, pushToken) in pending {
            registerUpdateTokenNatively(gameId: gameId, pushToken: pushToken)
        }
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
            // 조건3: 구독 전에 이미 떠 있는(원격 push-to-start 생성) Activity를 즉시 enumerate.
            // activityUpdates는 *구독 이후 신규*만 yield → 백그라운드 launch 시 이미 존재하는
            // 카드의 update 토큰을 놓칠 수 있다(observePushToken 중복가드로 이중 구독 무해).
            rescanActiveActivities()
            Task {
                for await activity in Activity<KBOGameAttributes>.activityUpdates {
                    observePushToken(activity, gameId: activity.attributes.gameId)
                }
            }
        }
    }

    /// 현재 살아있는 모든 Activity를 다시 enumerate해서 update 토큰 등록을 보장한다.
    /// `activityUpdates`는 *구독 이후 신규*만 yield하고, 앱이 백그라운드 suspend된 사이
    /// push-to-start로 생성된 카드(경기 30분 전 예정 카드)는 그 스트림에서 놓칠 수 있다 —
    /// 그러면 다음 포그라운드까지 update 토큰이 미등록되어 카드가 시작 스냅샷에 얼어붙는다.
    /// (하린아빠 실사례: 카드 18:00 생성, 토큰은 앱을 연 19:16에야 등록 → 그 사이 프리즈.
    /// 하루에 여러 번 앱을 열어도 매 포그라운드에서 재-enumerate를 안 해 늦게 잡혔다.)
    /// AppDelegate가 매 포그라운드 진입 시 호출 → "앱 열 때마다 확실히 토큰 확보"를 보장한다.
    /// observePushToken의 observedActivityIds 중복가드로 이미 관찰 중인 Activity는 무시된다
    /// (이중 구독/중복 등록 없음). iOS 16.2+.
    func rescanActiveActivities() {
        if #available(iOS 16.2, *) {
            for activity in Activity<KBOGameAttributes>.activities {
                observePushToken(activity, gameId: activity.attributes.gameId)
            }
        }
    }

    /// AppDelegate didFinishLaunching에서 호출 — 네이티브 부팅 시점에 observer attach.
    /// (기존엔 Capacitor 플러그인 load에서만 시작 → 웹뷰 의존이라 백그라운드 push-to-start
    /// 깨우기 때 미동작 = "앱 안 열면 카드 프리즈"의 근본 원인. 본 fix 핵심.)
    func startObservers() {
        observePushToStartToken()
        observeAllActivities()
    }

    /// 조건2 보강 — 앱이 포그라운드로 돌아올 때, App Group에 persist된 현재 push-to-start
    /// 토큰을 JS multicast로 재방출 → 포그라운드 JS가 `/register-start`로 재등록한다.
    /// pushToStartTokenUpdates는 *변경 시에만* yield하므로, 백그라운드에서 토큰이 rotate된 경우
    /// (네이티브가 persist는 했지만 register-start 재등록은 Bearer가 없어 못 함) 다음 포그라운드에
    /// 서버 매핑을 최신화한다. 값 동일해도 upsert라 무해.
    func resyncPushToStartTokenOnForeground() {
        // iOS 18 미만 — 구버전에서 persist된 토큰을 재등록하지 않는다(위 observePushToStartToken 게이트와 동일 사유).
        if #unavailable(iOS 18.0) { return }
        guard let token = latestPushToStartToken else { return }
        onPushToStartToken?(token)
    }

    /// Live Activity 사용 가능 여부(설정에서 꺼져 있을 수 있음).
    /// iOS 18 미만은 false — 익스텐션 ActivityConfiguration이 18+ 게이트라(워치 Smart Stack)
    /// 시작해도 렌더될 UI가 없다. 인앱 start·더미 경로 모두 이 게이트를 지난다.
    var isEnabled: Bool {
        if #unavailable(iOS 18.0) { return false }
        return ActivityAuthorizationInfo().areActivitiesEnabled
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
            // 문자중계 한 줄(1.0.7) — 잠금 LA와 동일 값을 홈위젯 large 카드에도 전달.
            "lastPlay": state.lastPlay ?? "",
            // 홈위젯 스냅샷은 scheduled 상태도 보존해야 예정 카드(경기 예정/시각)가 뜬다.
            // 기존엔 live/final만 기록 + startText 빈값이라 예정 LA 활성 시 홈위젯이 깨진 라이브로 렌더됐음.
            "status": state.isScheduled ? "scheduled" : (state.isFinal ? "final" : "live"),
            "startText": state.startTime ?? "",
            "dateText": "",
            "awayStarter": state.awayStarter ?? "",
            "homeStarter": state.homeStarter ?? "",
        ]
        WidgetSnapshotStore.write(dict)
    }
    #else
    var isEnabled: Bool { false }
    @discardableResult func startDummyActivity() -> Bool { false }
    func startObservers() {}
    func resyncPushToStartTokenOnForeground() {}
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
        var out = dict
        // 다음 예정 경기(위젯 06:00 자동 전환용)가 이번 쓰기에 없으면, 같은 경기의 기존
        // 스냅샷에서 보존한다. 라이브/종료 갱신이 JS 브리지와 네이티브 LA 라이프사이클 양쪽에서
        // 오므로, next 없는 경로가 덮어써 롤오버 데이터가 유실되는 걸 막는다(같은 gameId 한정).
        if out["next"] == nil,
           let data = ud.data(forKey: key),
           let prev = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let prevGameId = prev["gameId"] as? String,
           (out["gameId"] as? String) == prevGameId,
           let prevNext = prev["next"] {
            out["next"] = prevNext
        }
        // B안(위젯 stale 가드) 지원 — 마지막 기록 시각(epoch초)을 항상 새로 찍는다. 위젯
        // getTimeline이 live 스냅샷이 이 시각+5h를 넘도록 갱신 안 되면 LIVE를 떼고 '업데이트
        // 필요'로 표시한다(앱 미실행 + 무음 wake 유실 대비 백스톱).
        out["savedAt"] = Date().timeIntervalSince1970
        if let data = try? JSONSerialization.data(withJSONObject: out) {
            ud.set(data, forKey: key)
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// 경기 종료 무음 push 수신 시(A안) 홈위젯 스냅샷을 최종 스코어로 종료 처리한다.
    /// 현재 위젯이 이 경기(gameId)를 표시 중이고 아직 종료 전일 때만 갱신 — 다른/다음 경기
    /// 스냅샷을 덮어쓰지 않는다. next(06:00 롤오버)는 write()가 보존하며 멱등(이미 final이면 skip).
    static func markFinal(gameId: String, awayScore: Int, homeScore: Int) {
        guard let ud = UserDefaults(suiteName: appGroupId),
              let data = ud.data(forKey: key),
              let obj = try? JSONSerialization.jsonObject(with: data),
              var dict = obj as? [String: Any],
              (dict["hasGame"] as? Bool) == true,
              (dict["gameId"] as? String) == gameId else { return }
        if (dict["isFinal"] as? Bool) == true || (dict["status"] as? String) == "final" { return }
        dict["awayScore"] = awayScore
        dict["homeScore"] = homeScore
        dict["isFinal"] = true
        dict["status"] = "final"
        // 프리즈됐던 라이브 전용 값 정리(종료 카드엔 아웃/주자/투수·타자/문자중계 미표시).
        dict["outs"] = 0
        dict["onFirst"] = false
        dict["onSecond"] = false
        dict["onThird"] = false
        dict["pitcherName"] = ""
        dict["batterName"] = ""
        dict["lastPlay"] = ""
        write(dict)
    }
}
