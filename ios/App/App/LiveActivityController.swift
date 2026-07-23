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
                    // Slice B: 큐잉된 채널 ACK 재시도. register-start(JS) kickoff *뒤에* flush해
                    // ordering race 확률을 줄이되, 완료 순서는 어차피 보장 불가 — 401(unknown
                    // token)은 bounded 재시도로 귀결시켜 유실을 막는다(삼순 #663 blocker②).
                    flushChannelAckQueue()
                    if rotated {
                        NSLog("[LiveActivity] push-to-start token rotated → persisted; JS re-register requested")
                    }
                }
            }
        }
    }

    /// Activity의 push token 업데이트를 관찰해 콜백으로 흘려보낸다(W3 APNs 등록용).
    private func observePushToken(_ activity: Activity<KBOGameAttributes>, gameId: String) {
        // Broadcast 채널 activity(attributes.channelId marker 보유)는 per-activity update
        // 토큰 없이 채널 broadcast로 갱신된다(스펙 v4 §클라 3) — 토큰 관찰/등록을 스킵하고
        // 구독 ACK(SSOT 기록)로 라우팅한다. marker 부재(레거시 start)는 기존 경로 그대로.
        if #available(iOS 18.0, *), let channelId = activity.attributes.channelId {
            ackChannelActivity(gameId: gameId, channelId: channelId, activityId: activity.id)
            return
        }
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

    // MARK: - Broadcast 채널 구독/ACK (스펙 v4 Slice B, 빌드 16+)

    /// APNs env — 컴파일타임 빌드 상수(v4 blocker③: 런타임 entitlement 조회는 불가·불안정).
    /// Xcode 디버그 빌드 = sandbox / TestFlight·App Store = production.
    static let apnsEnvironment: String = {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }()

    /// ACK 상태 — settled(성공/큐잉/확정 폐기) *후에만* activity를 처리 완료로 마킹한다.
    /// 조회 전 선마킹은 GET 일시 실패를 영구 유실로 만든다(삼순 #663 blocker① — 같은 프로세스의
    /// foreground rescan까지 중복가드에 막혔음). inFlight는 동시 중복 시도 방지.
    private var ackedActivityIds = Set<String>()
    private var ackInFlightActivityIds = Set<String>()
    private let ackStateLock = NSLock()

    /// ACK 내구성 큐(스펙 v4 §서버 4) — network/5xx·GET 일시 실패·401 ordering race 분을
    /// persist 후 재시도. TTL·병합 규칙은 ChannelAckPolicy(최초 enqueue 기준 24h).
    private static let ackQueueKey = "kbo_channel_ack_queue"
    private let ackQueueLock = NSLock()
    /// 401(unknown token) 직후 지연 재flush 예약 상태 — 동시 1개만.
    private var delayedAckFlushScheduled = false
    /// flush single-flight(삼순 #663 재리뷰 blocker④) — 항목을 terminal 확정 전까지 persist에
    /// 유지하므로, 동시 flush가 같은 항목을 중복 처리하지 않게 process-level로 1개만 실행.
    /// 실행 중 트리거 유입은 rerun 플래그로 종료 후 1회 재실행(트리거 유실 없음).
    private var ackFlushRunning = false
    private var ackFlushRerun = false

    /// ACK 시도 종결 분류 — 큐 제거/유지와 activity 마킹을 결정한다.
    private enum AckSendResult: Equatable {
        case terminal       // 2xx 성공 or 확정 폐기 — persist 항목 제거 대상
        case retained       // 재시도 대기 — persist 큐가 소유(merge로 갱신됨)
        case persistFailed  // UserDefaults 접근 불가 — activity 마킹 금지(rescan 재시도)
    }

    /// GET /api/live-activity/channel — 양 env 채널 ID 중 *자기 빌드 env*의 active 채널만 선택
    /// (서버는 env를 추정하지 않는다, 스펙 v4 §서버 7). definitive(200/4xx)와
    /// retryable(network/5xx/파싱)을 구분해 반환한다(삼순 #663 blocker①).
    private func fetchActiveChannel(gameId: String) async -> ChannelAckPolicy.ChannelFetch {
        guard let url = URL(string: "https://keubo.fan/api/live-activity/channel?gameId=\(gameId)") else {
            return .active(nil)   // URL 조립 불가한 gameId = definitive(서버도 400)
        }
        do {
            let (data, resp) = try await URLSession.shared.data(from: url)
            guard let http = resp as? HTTPURLResponse else { return .retryableFailure }
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            return ChannelAckPolicy.classifyFetch(
                status: http.statusCode,
                parsed: obj != nil,
                channelId: obj?[Self.apnsEnvironment] as? String
            )
        } catch {
            return .retryableFailure
        }
    }

    /// 감지한 채널 activity의 구독 ACK — marker가 *현재 active 채널과 일치할 때만* 기록
    /// (스펙 v4 §서버 4: 지난 경기/폐기 채널 marker는 ACK 금지). 처리 완료 마킹은 성공/큐잉/
    /// 확정 폐기 후에만 — GET 일시 실패는 persist 큐로 승계한다(flush 때 active 재검증).
    @available(iOS 18.0, *)
    private func ackChannelActivity(gameId: String, channelId: String, activityId: String) {
        ackStateLock.lock()
        if ackedActivityIds.contains(activityId) || ackInFlightActivityIds.contains(activityId) {
            ackStateLock.unlock()
            return
        }
        ackInFlightActivityIds.insert(activityId)
        ackStateLock.unlock()
        Task {
            let settled: Bool
            switch ChannelAckPolicy.onFetch(await fetchActiveChannel(gameId: gameId), marker: channelId) {
            case .proceedAck:
                settled = await performChannelAck(gameId: gameId, channelId: channelId,
                                                  attempts: 0, firstQueuedAt: nil) != .persistFailed
            case .skipMismatch:
                NSLog("[LiveActivity] channel-ack skipped: marker != active channel (game=\(gameId))")
                settled = true
            case .enqueueForRetry:
                // blocker① — GET network/5xx/파싱 실패는 확정이 아니다: 큐로 승계(재시도 책임 이전).
                settled = enqueueChannelAck(gameId: gameId, channelId: channelId,
                                            attempts: 0, firstQueuedAt: nil)
            }
            ackStateLock.lock()
            ackInFlightActivityIds.remove(activityId)
            if settled { ackedActivityIds.insert(activityId) }
            ackStateLock.unlock()
        }
    }

    /// POST /api/live-activity/channel-ack — device-auth(p2s 토큰)로 구독 SSOT 기록.
    /// 재시도 정책: network/5xx = 큐 재시도, 401(unknown token) = bounded 재시도(삼순 #663
    /// blocker② — register-start(JS·Bearer)와의 완료 순서는 보장 불가, 즉시 폐기하면 최초
    /// 발급/rotation 직후 실제 ACK 유실), 그 외 4xx(409 stale 등) = 확정 폐기.
    /// 반환 = AckSendResult(terminal/retained/persistFailed) — flush는 terminal에서만 항목 제거.
    private func performChannelAck(gameId: String, channelId: String,
                                   attempts: Int, firstQueuedAt: TimeInterval?) async -> AckSendResult {
        guard let startToken = latestPushToStartToken else {
            // device-auth 인증자가 아직 없음 — persist 직후/다음 포그라운드 flush 때 재시도.
            return enqueueChannelAck(gameId: gameId, channelId: channelId,
                                     attempts: attempts, firstQueuedAt: firstQueuedAt) ? .retained : .persistFailed
        }
        guard let url = URL(string: "https://keubo.fan/api/live-activity/channel-ack") else { return .terminal }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "gameId": gameId,
            "channelId": channelId,
            "environment": Self.apnsEnvironment,
            "pushToStartToken": startToken,
        ])
        var status: Int? = nil
        if let (_, resp) = try? await URLSession.shared.data(for: req),
           let http = resp as? HTTPURLResponse {
            status = http.statusCode
        }
        let post = ChannelAckPolicy.classifyPost(status: status)
        // 조건5: 토큰값 미로깅 — 상태코드/시도 횟수만.
        switch ChannelAckPolicy.action(after: post, attempts: attempts) {
        case .done:
            NSLog("[LiveActivity] channel-ack ok (game=\(gameId))")
            return .terminal
        case .enqueue:
            NSLog("[LiveActivity] channel-ack retryable status=\(status.map { "\($0)" } ?? "network") attempts=\(attempts) → queued (game=\(gameId))")
            let nextAttempts = post == .unknownToken ? attempts + 1 : attempts
            let persisted = enqueueChannelAck(gameId: gameId, channelId: channelId,
                                              attempts: nextAttempts, firstQueuedAt: firstQueuedAt)
            // blocker② 보강 — register-start는 보통 수 초 내 완료: 다음 포그라운드까지 기다리지
            // 않고 같은 세션에서 수렴시킨다(bounded: attempts 상한 + TTL).
            if post == .unknownToken { scheduleDelayedAckFlush() }
            return persisted ? .retained : .persistFailed
        case .discard:
            NSLog("[LiveActivity] channel-ack rejected status=\(status.map { "\($0)" } ?? "-") — discarded (game=\(gameId))")
            return .terminal
        }
    }

    /// ACK 큐 persist(App Group) — 같은 (gameId, channelId)는 1개만 유지하되 *최초* queuedAt
    /// 보존·attempts max 병합(ChannelAckPolicy.merge, 삼순 #663 blocker③ — TTL sliding 방지).
    /// 반환 false = persist 불가(처리 완료 마킹 금지 → 다음 rescan이 재시도).
    @discardableResult
    private func enqueueChannelAck(gameId: String, channelId: String,
                                   attempts: Int, firstQueuedAt: TimeInterval?) -> Bool {
        guard let ud = UserDefaults(suiteName: WidgetSnapshotStore.appGroupId) else { return false }
        ackQueueLock.lock()
        defer { ackQueueLock.unlock() }
        let queue = (ud.array(forKey: Self.ackQueueKey) as? [[String: Any]]) ?? []
        let merged = ChannelAckPolicy.merge(queue: queue, gameId: gameId, channelId: channelId,
                                            attempts: attempts, firstQueuedAt: firstQueuedAt,
                                            now: Date().timeIntervalSince1970)
        ud.set(merged, forKey: Self.ackQueueKey)
        NSLog("[LiveActivity] channel-ack queued for retry (game=\(gameId), pending=\(merged.count))")
        return true
    }

    /// ACK 큐 flush — 부팅/포그라운드/p2s 토큰 persist/지연 예약에서 호출.
    /// 재리뷰 blocker④ — persist 큐를 선삭제하지 않는다: snapshot은 읽기 전용, 항목 제거는
    /// terminal(2xx 성공·확정 폐기·mismatch·TTL 만료) 확정 후 removeAckQueueItem으로만.
    /// GET/POST await 중 suspend·kill·crash되어도 항목이 persist에 남아 다음 부팅/포그라운드
    /// flush(startObservers/resync)가 복구한다. 동시 중복 처리는 process-level single-flight로 차단.
    func flushChannelAckQueue() {
        if #unavailable(iOS 18.0) { return }
        ackQueueLock.lock()
        if ackFlushRunning {
            ackFlushRerun = true   // 실행 중 트리거 유입 — 종료 후 1회 재실행(유실 없음)
            ackQueueLock.unlock()
            return
        }
        ackFlushRunning = true
        ackQueueLock.unlock()
        Task {
            repeat {
                await processAckQueueOnce()
                ackQueueLock.lock()
                let rerun = ackFlushRerun
                ackFlushRerun = false
                if !rerun { ackFlushRunning = false }
                ackQueueLock.unlock()
                if !rerun { break }
            } while true
        }
    }

    /// 큐 1회 순회 — 항목마다 active 채널을 *지금* 재검증(blocker①)하고, 제거/유지는
    /// ChannelAckPolicy disposition 규칙(terminal-only 제거)을 따른다. retryable 결과는
    /// 항목이 persist에 그대로 남아 있고(선삭제 없음) merge가 attempts/queuedAt만 갱신한다.
    private func processAckQueueOnce() async {
        guard let ud = UserDefaults(suiteName: WidgetSnapshotStore.appGroupId) else { return }
        ackQueueLock.lock()
        let raw = (ud.array(forKey: Self.ackQueueKey) as? [[String: Any]]) ?? []
        let queue = raw.filter { ($0["gameId"] is String) && ($0["channelId"] is String) }
        if queue.count != raw.count {
            ud.set(queue, forKey: Self.ackQueueKey)   // malformed 항목만 정리(재시도 불능)
        }
        ackQueueLock.unlock()
        guard !queue.isEmpty else { return }
        let now = Date().timeIntervalSince1970
        for item in queue {
            guard let gameId = item["gameId"] as? String,
                  let channelId = item["channelId"] as? String else { continue }
            let queuedAt = item["queuedAt"] as? TimeInterval ?? 0
            let attempts = item["attempts"] as? Int ?? 0
            if ChannelAckPolicy.isExpired(queuedAt: queuedAt, now: now) {
                NSLog("[LiveActivity] channel-ack expired (24h from first enqueue) — discarded (game=\(gameId))")
                removeAckQueueItem(gameId: gameId, channelId: channelId)   // terminal
                continue
            }
            let fetchAction = ChannelAckPolicy.onFetch(await fetchActiveChannel(gameId: gameId), marker: channelId)
            if let disposition = ChannelAckPolicy.disposition(onFetch: fetchAction) {
                if disposition == .remove {
                    NSLog("[LiveActivity] channel-ack dropped on flush: marker != active channel (game=\(gameId))")
                    removeAckQueueItem(gameId: gameId, channelId: channelId)   // terminal(definitive)
                }
                // .retain(GET retryable) — persist에 그대로 남음: 다음 flush가 재시도.
                continue
            }
            // proceedAck — POST 결과가 terminal 여부를 결정(ChannelAckPolicy.disposition(after:) 규칙:
            // done/discard만 remove). performChannelAck가 둘을 .terminal로 접어 반환한다.
            let result = await performChannelAck(gameId: gameId, channelId: channelId,
                                                 attempts: attempts, firstQueuedAt: queuedAt)
            if result == .terminal {
                removeAckQueueItem(gameId: gameId, channelId: channelId)
            }
            // .retained/.persistFailed — 항목 유지(retryable merge가 attempts/queuedAt 갱신).
        }
    }

    /// persist 큐에서 항목 제거 — terminal 결과 확정 시에만 호출(재리뷰 blocker④ 규칙).
    private func removeAckQueueItem(gameId: String, channelId: String) {
        guard let ud = UserDefaults(suiteName: WidgetSnapshotStore.appGroupId) else { return }
        ackQueueLock.lock()
        defer { ackQueueLock.unlock() }
        let queue = (ud.array(forKey: Self.ackQueueKey) as? [[String: Any]]) ?? []
        ud.set(ChannelAckPolicy.remove(queue: queue, gameId: gameId, channelId: channelId),
               forKey: Self.ackQueueKey)
    }

    /// blocker② 보강 — 401(unknown token) 직후 20초 뒤 1회 재flush 예약(동시 1개).
    /// 총 재시도량은 attempts 상한(5) + TTL(24h)이 차단하므로 영구 루프 없음.
    private func scheduleDelayedAckFlush() {
        ackQueueLock.lock()
        if delayedAckFlushScheduled {
            ackQueueLock.unlock()
            return
        }
        delayedAckFlushScheduled = true
        ackQueueLock.unlock()
        Task {
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            ackQueueLock.lock()
            delayedAckFlushScheduled = false
            ackQueueLock.unlock()
            flushChannelAckQueue()
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
            // ⚠️ 여기서는 마이그레이션을 하지 않는다(삼순 R2 blocker③) — rescan은 silent wake
            // (didReceiveRemoteNotification)에서도 불리는데, local `Activity.request()`는
            // foreground 시작 계약이다. 레거시→채널 교체는 foreground-active 전용 진입점
            // migrateLegacyActivitiesOnForeground()(didBecomeActive)가 담당 — 백그라운드
            // rescan 경로의 request는 0건이다.
        }
    }

    // MARK: - 경기 단위 직렬 큐 (삼순 R2 blocker①)
    //
    // start()·migration·end()가 같은 경기 카드에 동시에 손대면 "migration이 만든 새 채널
    // 카드를 start()가 종료 + migration이 레거시 종료 = 카드 0장" 경합이 가능하다(앱 오픈 시
    // native didBecomeActive migration과 웹뷰發 start()가 함께 도는 게 정상 진입 경로).
    // 경기별 Task 체인으로 상호 배제 — 락을 await 경계 너머로 들고 가지 않는다.
    // tail 항목은 경기 수만큼만 남는다(하루 최대 5경기 — 무해).
    private let gameSerialLock = NSLock()
    private var gameSerialTails: [String: Task<Void, Never>] = [:]

    private func withGameSerialQueue<T>(_ gameId: String,
                                        _ operation: @escaping () async -> T) async -> T {
        gameSerialLock.lock()
        let previous = gameSerialTails[gameId]
        let task = Task<T, Never> {
            _ = await previous?.value   // 앞 작업 완료 대기(FIFO 체인)
            return await operation()
        }
        gameSerialTails[gameId] = Task { _ = await task.value }
        gameSerialLock.unlock()
        return await task.value
    }

    // MARK: - 레거시 per-토큰 → broadcast 채널 마이그레이션 (포그라운드 rescan)
    //
    // iOS는 기존 activity의 pushType을 바꿀 수 없다(재생성만 가능). 판정은
    // ChannelMigrationPolicy(순수), 실행 순서는 *재생성 성공 후에만 레거시 end* —
    // 채널 fetch 실패/채널 없음/request 실패 어느 경로에서도 레거시 카드는 그대로
    // 남는다(카드만 죽고 끝나는 상황 원천 차단). 실패는 마킹하지 않아 다음 포그라운드가
    // 재시도한다(채널이 늦게 생기는 케이스 커버).

    /// 같은 game reconcile 동시 실행 방지(in-flight 가드). R4: 영구 성공 캐시(migratedGameIds)
    /// 제거 — *진행 중에만* 들어있고 완료 시 해제되어 다음 foreground가 다시 reconcile한다
    /// (중복 실행/카드 0장은 이 가드 + 경기 직렬 큐 + request-먼저 순서로 차단).
    private var reconcileInFlightGameIds = Set<String>()
    private let migrationLock = NSLock()
    /// 삼순 R2 blocker③ — 마이그레이션은 *foreground-active에서만* 실행한다. local
    /// `Activity.request()`는 foreground 시작 계약 — silent wake(didReceiveRemoteNotification)
    /// 경로의 rescan은 토큰 재등록만 하고 request 0건을 보장한다. 진입점은
    /// applicationDidBecomeActive — cold launch·백그라운드 복귀 모두 커버한다
    /// (willEnterForeground는 cold launch에서 호출되지 않음). 백그라운드 자동구제가 목표면
    /// current channel push-to-start 등 지원되는 경로로 별도 분리한다(본 PR 범위 밖).
    func migrateLegacyActivitiesOnForeground() {
        if #available(iOS 18.0, *) {
            // didBecomeActive = 메인 스레드 — applicationState 안전 조회.
            let foreground = UIApplication.shared.applicationState == .active
            guard foreground else { return }
            // R4: activity 단위가 아니라 *game 단위*로 reconcile — 같은 game의 카드 전체를
            // 한 번에 보아 현재 채널 1장/비현재 0장으로 수렴시킨다([현재 B, 구채널 A] 순서
            // 잔존·B→C 연속 교체 미검사 사고 차단).
            let gameIds = Set(Activity<KBOGameAttributes>.activities.map { $0.attributes.gameId })
            for gameId in gameIds {
                reconcileGameIfNeeded(gameId, isForegroundActive: foreground)
            }
        }
    }

    @available(iOS 18.0, *)
    private func reconcileGameIfNeeded(_ gameId: String, isForegroundActive: Bool) {
        // 이 game에 라이브 active 카드가 있는지 — scheduled/final만 있는 game은 reconcile 안 함.
        let gameHasLiveCard = Activity<KBOGameAttributes>.activities.contains {
            $0.attributes.gameId == gameId
                && $0.contentState.status == .live && $0.activityState == .active
        }
        migrationLock.lock()
        let pre = ChannelMigrationPolicy.preflight(
            osAtLeast18: true,   // #available 게이트 통과 — 정책 표와의 정합용 명시 인자
            isForegroundActive: isForegroundActive,   // R2 blocker③ — silent wake 컨텍스트 차단
            gameHasLiveCard: gameHasLiveCard,
            inFlight: reconcileInFlightGameIds.contains(gameId))   // R4: 진행 중에만 true(영구 캐시 아님)
        guard pre == .proceed else {
            migrationLock.unlock()
            return
        }
        reconcileInFlightGameIds.insert(gameId)
        migrationLock.unlock()
        Task {
            defer {
                migrationLock.lock()
                reconcileInFlightGameIds.remove(gameId)   // 완료 시 해제 — 다음 foreground가 재 reconcile
                migrationLock.unlock()
            }
            // R2 blocker① — 같은 경기 start()/end()와 상호 배제(경기 직렬 큐).
            await withGameSerialQueue(gameId) { [self] in
                await reconcileGameSerialized(gameId: gameId)
            }
        }
    }

    /// 경기 직렬 큐 안에서 실행되는 game 단위 reconcile 본체 — 락 대기 중 변한 상태를 재검증한다.
    /// 직렬 구간이므로 같은 game의 start()/end()와는 배타적이지만, 사용자 dismiss·OS 종료는
    /// 직렬 큐 밖에서 일어난다 — 그래서 카드 스냅샷은 고정하지 않고 orchestrator가 요구할 때마다
    /// 재-enumerate한다(R6).
    /// R5: 게이트·순서·실패 처리 조립은 ChannelMigrationOrchestrator 한 곳 — 여기서는
    /// ActivityKit/UIKit effect만 주입한다(스모크가 mock effect로 동일 조립 코드를 실행).
    @available(iOS 18.0, *)
    private func reconcileGameSerialized(gameId: String) async {
        // R6: plan/request/end는 반드시 *최신* enumerate 결과 기준 — orchestrator가 channel
        // fetch 완료 후 재-enumerate한 fresh snapshot으로 계산한다(fetch 중 사용자 dismiss/
        // final·ended 카드를 stale snapshot이 새 채널 카드로 되살리는 유령 카드 부활 차단).
        // effect closure의 idx는 항상 마지막 enumerate의 liveCards를 가리킨다.
        var liveCards: [Activity<KBOGameAttributes>] = []
        let outcome = await ChannelMigrationOrchestrator.reconcile(
            enumerateCards: {
                liveCards = Activity<KBOGameAttributes>.activities.filter {
                    $0.attributes.gameId == gameId && $0.activityState == .active
                        && $0.contentState.status == .live
                }
                return liveCards.map { $0.attributes.channelId }
            },
            isForegroundActive: {
                // MainActor에서 매 호출 재평가 — 직렬 구간 진입 직후 1회 + channel fetch를
                // await한 뒤 request/end 직전 1회(R5 blocker① — fetch 중 background 전환
                // 시 background local request 0 계약 보장).
                await MainActor.run { UIApplication.shared.applicationState == .active }
            },
            fetchActiveChannel: {
                // 현재 active 채널 1회 조회 — 카드 marker 배열과 대조해 game 단위 플랜.
                await self.fetchActiveChannel(gameId: gameId)
            },
            adoptCurrent: { keep in
                // 현재 채널 카드 이미 존재 — 신규 request 0. 현재 카드 재-ack.
                let currentCard = liveCards[keep]
                guard let channelId = currentCard.attributes.channelId else { return }   // keep은 항상 marker 보유
                self.ackChannelActivity(gameId: gameId, channelId: channelId, activityId: currentCard.id)
                if self.currentActivity?.attributes.gameId == gameId,
                   self.currentActivity?.attributes.channelId != channelId {
                    self.currentActivity = currentCard
                }
            },
            requestCurrent: { channelId in
                // 현재 채널 카드 없음 — request 먼저(성공 시에만 orchestrator가 end 진행).
                guard let template = liveCards.first else { return false }   // R6: fetch 후 fresh snapshot 비어있지 않음 보장(cardsGonePostFetch 가드)
                var channelAttributes = template.attributes
                channelAttributes.channelId = channelId
                let state = template.contentState
                do {
                    let newActivity = try Activity.request(
                        attributes: channelAttributes,
                        content: .init(state: state, staleDate: nil),
                        pushType: .channel(channelId)
                    )
                    if self.currentActivity?.attributes.gameId == gameId,
                       self.currentActivity?.attributes.channelId != channelId {
                        self.currentActivity = newActivity
                    }
                    self.ackChannelActivity(gameId: gameId, channelId: channelId, activityId: newActivity.id)
                    return true
                } catch {
                    NSLog("[LiveActivity] reconcile: →current channel request failed → keep all cards: \(error.localizedDescription)")
                    return false
                }
            },
            endCard: { idx in
                // 비현재(구채널·레거시·중복) end — orchestrator가 현재 카드 확보 후에만 호출.
                // idx는 fetch 후 fresh snapshot(liveCards) 기준 — 방금 request한 새 카드는
                // snapshot에 없으므로 살아남는다(카드 0장 불가).
                let other = liveCards[idx]
                await other.end(using: other.contentState, dismissalPolicy: .immediate)
            }
        )
        switch outcome {
        case .adopted(_, let ended):
            NSLog("[LiveActivity] reconcile: adopted current channel card, non-current cleaned (game=\(gameId), removed=\(ended.count))")
        case .recreated(_, let ended):
            NSLog("[LiveActivity] reconcile: recreated current channel card, non-current cleaned (game=\(gameId), removed=\(ended.count))")
        case .abortBackgroundPostFetch:
            NSLog("[LiveActivity] reconcile: backgrounded during channel fetch → abort, request/end 0 (game=\(gameId))")
        case .abortBackgroundPreEffect:
            NSLog("[LiveActivity] reconcile: backgrounded during fresh enumerate → abort before effects, request/end 0 (game=\(gameId))")
        case .cardsGonePostFetch:
            NSLog("[LiveActivity] reconcile: all cards dismissed/ended during channel fetch → no-op, request/end 0 (game=\(gameId))")
        case .abortBackgroundPreFetch, .abortLegacyGone, .retryNextForeground, .requestFailedKeepAll:
            break   // no-op 계열(전 카드 유지) — 다음 foreground가 재시도
        }
    }

    /// AppDelegate didFinishLaunching에서 호출 — 네이티브 부팅 시점에 observer attach.
    /// (기존엔 Capacitor 플러그인 load에서만 시작 → 웹뷰 의존이라 백그라운드 push-to-start
    /// 깨우기 때 미동작 = "앱 안 열면 카드 프리즈"의 근본 원인. 본 fix 핵심.)
    func startObservers() {
        observePushToStartToken()
        observeAllActivities()
        flushChannelAckQueue()   // Slice B: 이전 세션에서 실패(network/5xx)한 채널 ACK 재시도
    }

    /// 조건2 보강 — 앱이 포그라운드로 돌아올 때, App Group에 persist된 현재 push-to-start
    /// 토큰을 JS multicast로 재방출 → 포그라운드 JS가 `/register-start`로 재등록한다.
    /// pushToStartTokenUpdates는 *변경 시에만* yield하므로, 백그라운드에서 토큰이 rotate된 경우
    /// (네이티브가 persist는 했지만 register-start 재등록은 Bearer가 없어 못 함) 다음 포그라운드에
    /// 서버 매핑을 최신화한다. 값 동일해도 upsert라 무해.
    func resyncPushToStartTokenOnForeground() {
        // iOS 18 미만 — 구버전에서 persist된 토큰을 재등록하지 않는다(위 observePushToStartToken 게이트와 동일 사유).
        if #unavailable(iOS 18.0) { return }
        flushChannelAckQueue()   // Slice B: 포그라운드 복귀마다 대기 중 채널 ACK 재시도
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

        // R2 blocker① — 같은 경기 migration/end와 상호 배제(경기 직렬 큐).
        return await withGameSerialQueue(gameId) { [self] in
            await startSerialized(gameId: gameId, awayTeam: awayTeam, homeTeam: homeTeam,
                                  awayTeamCode: awayTeamCode, homeTeamCode: homeTeamCode,
                                  myTeamCode: myTeamCode, state: state)
        }
    }

    /// 경기 직렬 큐 안에서 실행되는 start 본체.
    private func startSerialized(
        gameId: String,
        awayTeam: String,
        homeTeam: String,
        awayTeamCode: String,
        homeTeamCode: String,
        myTeamCode: String,
        state: KBOGameAttributes.ContentState
    ) async -> Bool {
        // 시스템에 살아있는 *모든* Activity를 회수해 정리한다 (앱 재시작·더미 누적으로
        // 여러 장 남은 상태를 코드로 거둠 — `.activities.first` 하나만으론 정리 불가, 삼순 #220).
        // R2 blocker①: 같은 경기 카드 중 *채널 카드(marker 보유)를 최우선 보존* — 기존 임의
        // first-card 보존이 migration이 방금 만든 채널 카드를 죽이던 경합 차단. 카드가
        // 하나라도 있으면 반드시 한 장은 보존된다(카드 0장 불가). 나머지(다른 경기·중복·
        // 더미)는 즉시 종료 — 전환/중복 종료는 .immediate, 15분 잔상은 경기 final(W4)에만.
        let all = Activity<KBOGameAttributes>.activities
        let sameGame = all.filter { $0.attributes.gameId == gameId }
        let keepIdx = ChannelMigrationPolicy.keepIndex(
            hasChannelMarker: sameGame.map { $0.attributes.channelId != nil })
        let keep = keepIdx.map { sameGame[$0] }
        for activity in all where activity.id != keep?.id {
            await activity.end(using: activity.contentState, dismissalPolicy: .immediate)
        }
        currentActivity = keep

        // 같은 경기가 이미 떠 있으면 갱신만 (재진입 중복 방지)
        if let existing = keep {
            await existing.update(using: state)
            if #available(iOS 18.0, *), let channelId = existing.attributes.channelId {
                // 보존된 채널 카드 — 구독 SSOT 재확인(ackedActivityIds 중복가드로 멱등).
                ackChannelActivity(gameId: gameId, channelId: channelId, activityId: existing.id)
            } else {
                observePushToken(existing, gameId: gameId)   // 레거시 보존분 토큰 재관찰
            }
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

        // R2 blocker④ — build16+/iOS18+ 신규 시작은 *채널 카드만*(스펙 v4 §클라 2). 채널
        // 미준비(definitive 부재)·GET 일시 실패·request 실패 = 시작 유보(false 반환, 다음
        // 기회 재시도 — 웹뷰 재진입/다음 포그라운드가 다시 부른다). 기존 레거시 `.token`
        // fallback 분기 제거 — 7/23 사고 입구: fallback으로 태어난 레거시 카드가 예산
        // 스로틀에 갇혀 이닝 단위 지연. iOS 17 이하는 위 isEnabled(18 게이트)로 start 자체가
        // no-op이고, build 15 이하 구버전 바이너리의 레거시 경로는 본 코드와 무관(그대로 유지).
        guard #available(iOS 18.0, *) else { return false }   // isEnabled와 동일 게이트(방어적)
        switch ChannelMigrationPolicy.startDecision(await fetchActiveChannel(gameId: gameId)) {
        case .deferStart:
            NSLog("[LiveActivity] start deferred: channel not ready (game=\(gameId)) — no legacy fallback")
            return false
        case .startChannelCard(let channelId):
            var channelAttributes = attributes
            channelAttributes.channelId = channelId
            do {
                let activity = try Activity.request(
                    attributes: channelAttributes,
                    content: .init(state: state, staleDate: nil),
                    pushType: .channel(channelId)
                )
                currentActivity = activity
                ackChannelActivity(gameId: gameId, channelId: channelId, activityId: activity.id)
                writeWidgetSnapshot(attributes: channelAttributes, state: state)
                NSLog("[LiveActivity] started game=\(gameId) via channel id=\(activity.id)")
                return true
            } catch {
                // request 실패도 시작 유보 — 레거시 fallback 금지(R2 blocker④).
                NSLog("[LiveActivity] channel start failed → deferred, no legacy fallback: \(error.localizedDescription)")
                return false
            }
        }
    }

    /// 진행 중 Activity 상태 갱신(로컬). W3에서 push로 대체/병행.
    func update(_ state: KBOGameAttributes.ContentState) async {
        guard let activity = currentActivity else { return }
        await activity.update(using: state)
        writeWidgetSnapshot(attributes: activity.attributes, state: state)
    }

    /// 종료(경기 final) — 최종 content-state + 15분 후 자동 제거(dismissal-date).
    /// R2 blocker① — 같은 경기 start/migration과 상호 배제(경기 직렬 큐).
    func end(finalState: KBOGameAttributes.ContentState? = nil) async {
        guard let gameId = currentActivity?.attributes.gameId else { return }
        await withGameSerialQueue(gameId) { [self] in
            await endCurrent(immediate: false, finalState: finalState)
        }
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
    func migrateLegacyActivitiesOnForeground() {}
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
        if let data = ud.data(forKey: key),
           let prev = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let prevGameId = prev["gameId"] as? String,
           (out["gameId"] as? String) == prevGameId {
            if out["next"] == nil, let prevNext = prev["next"] {
                out["next"] = prevNext
            }
            // 역순 배달 fence 보존 (삼순 #674 재리뷰 blocker①) — 같은 경기의 다른 writer
            // (JS 브리지 writeWidgetSnapshot / LA 라이프사이클 refresh)는 liveEventMs 키가
            // 없는 dict로 전체 교체하므로, 여기서 승계하지 않으면 fence가 삭제돼
            // `new push → same-game write → old push` 순서에서 늦은 배달이 점수를 되돌린다.
            // 계약: same-game write = fence 보존 / 전진은 markLiveScore만 / 다른 경기 = 리셋.
            // TS 미러 shouldPreserveWidgetFence(ios-widget-policy.ts)와 동치 유지.
            if out["liveEventMs"] == nil, let prevEv = prev["liveEventMs"] {
                out["liveEventMs"] = prevEv
            }
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

    /// 라이브 스코어 무음 push 수신 시(1.0.9 build 17) 홈위젯 스냅샷을 갱신한다.
    /// iOS 홈위젯은 서버 push로 직접 못 그리므로, 스코어축 변화 시 무음 wake로 이 경로가 돈다.
    /// 현재 위젯이 *이 경기(gameId)를 표시 중일 때만* 갱신 — 팀/최애팀/next는 기존 스냅샷에서
    /// 보존하고 라이브 필드만 덮어쓴다(브로드캐스트 push라 per-user myTeamCode를 실을 수 없음).
    /// 스냅샷이 없거나 다른 경기면 no-op(위젯 미표시 유저 — myTeamCode를 날조하지 않는다).
    /// scheduled 스냅샷(경기 전 카드)도 이 경기면 live로 전환. 이미 final이면 skip(종료 우선).
    /// 반환값 = 실제 적용 여부(삼순 #674 재리뷰 blocker②) — no-op(스냅샷 없음/다른 경기/
    /// final/역순 거부)이면 false. AppDelegate가 completionHandler(.newData/.noData) 분기에 사용해
    /// silent-push 예산 보고를 정직하게 유지한다.
    @discardableResult
    static func markLiveScore(
        gameId: String, awayScore: Int, homeScore: Int,
        inning: Int, isTopInning: Bool, outs: Int,
        onFirst: Bool, onSecond: Bool, onThird: Bool,
        pitcherName: String, batterName: String, lastPlay: String,
        eventMs: Double
    ) -> Bool {
        guard let ud = UserDefaults(suiteName: appGroupId),
              let data = ud.data(forKey: key),
              let obj = try? JSONSerialization.jsonObject(with: data),
              var dict = obj as? [String: Any],
              (dict["hasGame"] as? Bool) == true,
              (dict["gameId"] as? String) == gameId else { return false }
        // 이미 종료 처리된 카드는 라이브로 되돌리지 않는다(game_end가 먼저 왔을 수 있음 — final → old 방어).
        if (dict["isFinal"] as? Bool) == true || (dict["status"] as? String) == "final" { return false }
        // 지연/역순 배달 fence(삼순 #674 blocker③) — 저장된 이벤트 시각보다 오래된(≤) push는
        // 무시해 늦은 배달이 최신 점수를 되돌리지 못하게 한다(new → old 방어).
        // 계약은 TS 미러 shouldApplyWidgetLiveEvent(ios-widget-policy.ts)와 동치 — 양쪽 동시 유지.
        if let stored = dict["liveEventMs"] as? Double, eventMs <= stored { return false }
        dict["awayScore"] = awayScore
        dict["homeScore"] = homeScore
        dict["inning"] = inning
        dict["isTopInning"] = isTopInning
        dict["outs"] = outs
        dict["onFirst"] = onFirst
        dict["onSecond"] = onSecond
        dict["onThird"] = onThird
        dict["pitcherName"] = pitcherName
        dict["batterName"] = batterName
        dict["lastPlay"] = lastPlay
        dict["isFinal"] = false
        dict["status"] = "live"
        // startText(예정 시각)는 live 전환 시 비운다 — 예정 카드 잔재 제거.
        dict["startText"] = ""
        // fence 기준 저장 — 다음 push가 이보다 오래되면(≤) 거부된다. 스냅샷 JSON에 함께
        // 영속되며 WidgetGameSnapshot Codable에는 없는 키라 렌더엔 무영향(dict 경유만 읽음).
        dict["liveEventMs"] = eventMs
        write(dict) // 팀코드/myTeamCode/next/fence 보존 + savedAt 갱신 + reloadAllTimelines
        return true
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
