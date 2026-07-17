//
//  ChannelAckPolicy.swift
//  KBO 크보팬 — 메인 앱 타깃
//
//  Broadcast 채널 구독 ACK의 판정/재시도/TTL 정책 (순수 로직, Foundation 전용).
//  LiveActivityController가 소비하고, scripts/qa/la-channel-ack-policy-smoke.swift 가
//  회귀를 고정한다 — 삼순 PR #663 NO-GO 3건:
//   ① GET 일시 실패(network/5xx/파싱)를 "채널 없음" 확정과 구분 — 폐기 아닌 큐 재시도
//   ② 401(unknown token) = register-start ordering race 가능 — 즉시 폐기 아닌 bounded 재시도
//   ③ 재큐잉 시 최초 queuedAt 보존 — 24h TTL sliding 금지
//

import Foundation

enum ChannelAckPolicy {

    // MARK: - GET /api/live-activity/channel 판정 (blocker①)

    /// GET 결과 — definitive(200/4xx)와 retryable(network/5xx/파싱 실패)을 구분한다.
    /// 기존엔 둘 다 nil로 합쳐져 일시 실패가 "채널 없음" 확정으로 처리됐다.
    enum ChannelFetch: Equatable {
        case active(String?)      // definitive — 자기 env의 active 채널 ID(없으면 nil)
        case retryableFailure     // network 오류·5xx·파싱 실패 — 확정 아님
    }

    /// status nil = network 오류. 200 + 파싱 성공 = definitive, 4xx = definitive(채널 없음
    /// — 서버 계약상 잘못된 gameId 등), 그 외(5xx·파싱 실패) = retryable.
    static func classifyFetch(status: Int?, parsed: Bool, channelId: String?) -> ChannelFetch {
        guard let status = status else { return .retryableFailure }
        if (200..<300).contains(status) {
            return parsed ? .active(channelId) : .retryableFailure
        }
        if (400..<500).contains(status) { return .active(nil) }
        return .retryableFailure
    }

    /// GET 결과 + activity marker → 다음 행동. retryable은 persist 큐로 보내고(flush 때
    /// active 재검증) *확정 처리로 마킹하지 않는다* — blocker① 핵심 분기.
    enum FetchAction: Equatable {
        case proceedAck        // marker == active 채널 — ACK 진행
        case skipMismatch      // definitive mismatch(지난 경기/폐기 채널) — 폐기·처리 완료
        case enqueueForRetry   // retryable — 큐 재시도, 선마킹 금지
    }

    static func onFetch(_ fetch: ChannelFetch, marker channelId: String) -> FetchAction {
        switch fetch {
        case .active(let active):
            return active == channelId ? .proceedAck : .skipMismatch
        case .retryableFailure:
            return .enqueueForRetry
        }
    }

    // MARK: - POST /api/live-activity/channel-ack 판정 (blocker②)

    /// 서버 계약: 401 = unknown token(register-start 미완료 ordering race 가능),
    /// 409/400 등 나머지 4xx = 확정 거절, 5xx/network = retryable.
    enum AckPost: Equatable {
        case success
        case retryable
        case unknownToken
        case definitiveReject
    }

    static func classifyPost(status: Int?) -> AckPost {
        guard let status = status else { return .retryable }
        if (200..<300).contains(status) { return .success }
        if status == 401 { return .unknownToken }
        if (400..<500).contains(status) { return .definitiveReject }
        return .retryable
    }

    /// POST 결과 → 종결 행동. unknownToken을 곧장 폐기하면 최초 발급/rotation 직후
    /// register-start(JS·Bearer)와 channel-ack(native·device-auth)의 완료 순서에 따라
    /// 실제 ACK가 유실된다 — bounded 재시도(attempts 상한 + 최초 enqueue 기준 TTL 이중 차단).
    enum Action: Equatable {
        case done      // 성공 — 처리 완료
        case enqueue   // persist 큐 재시도
        case discard   // 확정 폐기
    }

    static let maxUnknownTokenAttempts = 5

    /// attempts = 이 항목의 누적 unknown-token 재시도 횟수(첫 시도 0).
    static func action(after post: AckPost, attempts: Int) -> Action {
        switch post {
        case .success: return .done
        case .retryable: return .enqueue   // network/5xx — TTL이 차단
        case .unknownToken:
            return attempts + 1 >= maxUnknownTokenAttempts ? .discard : .enqueue
        case .definitiveReject: return .discard
        }
    }

    // MARK: - persist 큐 merge / TTL (blocker③)

    /// TTL — *최초 enqueue 시각* 기준 24h. 재큐잉마다 now로 리셋하면 sliding 되어
    /// 영구 큐 방지가 깨진다.
    static let ttl: TimeInterval = 24 * 60 * 60

    static func isExpired(queuedAt: TimeInterval, now: TimeInterval) -> Bool {
        now - queuedAt > ttl
    }

    /// 같은 (gameId, channelId)는 1개만 유지하되 queuedAt은 min(기존, firstQueuedAt ?? now)
    /// 보존, attempts는 max 병합(리셋 금지). flush 재큐잉 경로는 firstQueuedAt으로 원래
    /// 시각을 넘긴다(큐에서 이미 꺼낸 뒤라 기존 항목 병합만으론 보존 불가).
    static func merge(queue: [[String: Any]], gameId: String, channelId: String,
                      attempts: Int, firstQueuedAt: TimeInterval?, now: TimeInterval) -> [[String: Any]] {
        var out = queue
        var queuedAt = firstQueuedAt ?? now
        var mergedAttempts = attempts
        if let idx = out.firstIndex(where: {
            ($0["gameId"] as? String) == gameId && ($0["channelId"] as? String) == channelId
        }) {
            if let prev = out[idx]["queuedAt"] as? TimeInterval { queuedAt = min(prev, queuedAt) }
            if let prevAttempts = out[idx]["attempts"] as? Int { mergedAttempts = max(prevAttempts, mergedAttempts) }
            out.remove(at: idx)
        }
        out.append(["gameId": gameId, "channelId": channelId, "queuedAt": queuedAt, "attempts": mergedAttempts])
        return out
    }
}
