//
//  la-channel-ack-policy-smoke.swift
//  Broadcast 채널 구독 ACK 정책 회귀 스모크 — ios/App/App/ChannelAckPolicy.swift 를 고정한다.
//
//  삼순 PR #663 NO-GO 회귀 기준 3건:
//   ① GET 5xx/네트워크 실패 → 폐기가 아니라 큐 재시도 → foreground flush에서 ACK 성공
//   ② 신규/rotation 토큰 register-start 지연(401 unknown token) → 유실 없음(bounded 재시도)
//   ③ 5xx 반복 재큐잉 중에도 최초 enqueue 시각 보존 → 24h 초과 시 폐기(TTL sliding 금지)
//
//  실행: npm run qa:la-ack-policy (scripts/qa/la-channel-ack-policy-smoke.sh, macOS/swiftc 필요)
//

import Foundation

@main
struct LaChannelAckPolicySmoke {
    static var passed = 0
    static var failed = 0

    static func check(_ name: String, _ cond: Bool) {
        if cond { passed += 1; print("  PASS \(name)") }
        else { failed += 1; print("❌ FAIL \(name)") }
    }

    static func main() {
        // ── 회귀① GET 일시 실패 ≠ "채널 없음" 확정 ──
        print("[회귀① GET 실패 구분 — retryable은 큐로, 선마킹 금지]")
        check("network 오류 = retryable",
              ChannelAckPolicy.classifyFetch(status: nil, parsed: false, channelId: nil) == .retryableFailure)
        check("5xx = retryable",
              ChannelAckPolicy.classifyFetch(status: 503, parsed: false, channelId: nil) == .retryableFailure)
        check("200 + 파싱 실패 = retryable",
              ChannelAckPolicy.classifyFetch(status: 200, parsed: false, channelId: nil) == .retryableFailure)
        check("200 + 채널 있음 = definitive active",
              ChannelAckPolicy.classifyFetch(status: 200, parsed: true, channelId: "ch1") == .active("ch1"))
        check("200 + 자기 env 채널 없음 = definitive nil",
              ChannelAckPolicy.classifyFetch(status: 200, parsed: true, channelId: nil) == .active(nil))
        check("400 = definitive nil(서버 계약: 잘못된 gameId)",
              ChannelAckPolicy.classifyFetch(status: 400, parsed: false, channelId: nil) == .active(nil))
        check("retryable → enqueueForRetry(폐기·선마킹 금지)",
              ChannelAckPolicy.onFetch(.retryableFailure, marker: "ch1") == .enqueueForRetry)
        check("definitive mismatch → skip(확정 폐기)",
              ChannelAckPolicy.onFetch(.active("other"), marker: "ch1") == .skipMismatch)
        check("definitive 채널 부재 → skip(확정 폐기)",
              ChannelAckPolicy.onFetch(.active(nil), marker: "ch1") == .skipMismatch)
        check("match → ACK 진행",
              ChannelAckPolicy.onFetch(.active("ch1"), marker: "ch1") == .proceedAck)

        // 시나리오①: GET 5xx → 큐 보존 → foreground flush 재검증 match → POST 2xx = ACK 성공
        let t0: TimeInterval = 1_000_000
        var q1: [[String: Any]] = []
        q1 = ChannelAckPolicy.merge(queue: q1, gameId: "20260717LGKT0", channelId: "ch1",
                                    attempts: 0, firstQueuedAt: nil, now: t0)
        check("시나리오①: GET 실패분 큐에 보존(유실 없음)", q1.count == 1)
        check("시나리오①: flush 재검증 match → ACK 진행",
              ChannelAckPolicy.onFetch(.active("ch1"), marker: "ch1") == .proceedAck)
        check("시나리오①: POST 2xx → done(ACK 성공)",
              ChannelAckPolicy.action(after: ChannelAckPolicy.classifyPost(status: 200), attempts: 0) == .done)

        // ── 회귀② 401 unknown token = bounded 재시도(유실 없음) ──
        print("[회귀② register-start ordering race — 401 bounded 재시도]")
        check("401 = unknownToken", ChannelAckPolicy.classifyPost(status: 401) == .unknownToken)
        check("409(stale 채널) = definitiveReject", ChannelAckPolicy.classifyPost(status: 409) == .definitiveReject)
        check("400 = definitiveReject", ChannelAckPolicy.classifyPost(status: 400) == .definitiveReject)
        check("500 = retryable", ChannelAckPolicy.classifyPost(status: 500) == .retryable)
        check("network = retryable", ChannelAckPolicy.classifyPost(status: nil) == .retryable)
        check("401 attempts 0 → enqueue(즉시 폐기 금지)",
              ChannelAckPolicy.action(after: .unknownToken, attempts: 0) == .enqueue)
        check("401 attempts 3 → enqueue",
              ChannelAckPolicy.action(after: .unknownToken, attempts: 3) == .enqueue)
        check("401 attempts 4 → discard(bounded, 상한 5)",
              ChannelAckPolicy.action(after: .unknownToken, attempts: 4) == .discard)
        check("409 → discard(계약 유지: ordering 외 4xx는 확정 폐기)",
              ChannelAckPolicy.action(after: .definitiveReject, attempts: 0) == .discard)
        check("5xx는 attempts 무관 enqueue(TTL이 차단)",
              ChannelAckPolicy.action(after: .retryable, attempts: 99) == .enqueue)

        // 시나리오②: rotation 직후 401 → attempts 증가 재큐잉 → register-start 완료 후 성공
        var q2: [[String: Any]] = []
        q2 = ChannelAckPolicy.merge(queue: q2, gameId: "g", channelId: "c",
                                    attempts: 1, firstQueuedAt: nil, now: t0)
        check("시나리오②: 401 재큐잉 유지(유실 없음)",
              q2.count == 1 && (q2[0]["attempts"] as? Int) == 1)
        check("시나리오②: register-start 완료 후 재flush POST 2xx → done",
              ChannelAckPolicy.action(after: .success, attempts: 1) == .done)

        // ── 회귀③ TTL은 최초 enqueue 기준 — sliding 금지 ──
        print("[회귀③ TTL sliding 금지 — 최초 queuedAt 보존]")
        var q3: [[String: Any]] = []
        q3 = ChannelAckPolicy.merge(queue: q3, gameId: "g", channelId: "c",
                                    attempts: 0, firstQueuedAt: nil, now: t0)
        // 5xx 반복: flush가 꺼낸 항목을 원래 queuedAt(firstQueuedAt)과 함께 재큐잉하는 경로 재현
        for i in 1...10 {
            let prevQueuedAt = q3[0]["queuedAt"] as? TimeInterval
            q3 = ChannelAckPolicy.merge(queue: [], gameId: "g", channelId: "c",
                                        attempts: 0, firstQueuedAt: prevQueuedAt,
                                        now: t0 + TimeInterval(i) * 3600)
        }
        check("10회 재큐잉에도 최초 queuedAt 보존", (q3[0]["queuedAt"] as? TimeInterval) == t0)
        check("최초+24h 이내 = 유지", !ChannelAckPolicy.isExpired(queuedAt: t0, now: t0 + 24 * 3600))
        check("최초+24h 초과 = 폐기", ChannelAckPolicy.isExpired(queuedAt: t0, now: t0 + 24 * 3600 + 1))
        // 큐에 남아있던 동일 키 항목과의 병합도 min(queuedAt) 보존
        var q4 = q3
        q4 = ChannelAckPolicy.merge(queue: q4, gameId: "g", channelId: "c",
                                    attempts: 0, firstQueuedAt: nil, now: t0 + 100_000)
        check("큐 잔존 항목 병합 시에도 min(queuedAt) 보존",
              q4.count == 1 && (q4[0]["queuedAt"] as? TimeInterval) == t0)
        var q5: [[String: Any]] = []
        q5 = ChannelAckPolicy.merge(queue: q5, gameId: "g", channelId: "c", attempts: 3, firstQueuedAt: nil, now: t0)
        q5 = ChannelAckPolicy.merge(queue: q5, gameId: "g", channelId: "c", attempts: 0, firstQueuedAt: nil, now: t0 + 10)
        check("attempts는 max 병합(리셋 금지)", (q5[0]["attempts"] as? Int) == 3)
        var q6 = q5
        q6 = ChannelAckPolicy.merge(queue: q6, gameId: "g2", channelId: "c2", attempts: 0, firstQueuedAt: nil, now: t0)
        check("다른 (gameId, channelId)는 별도 항목", q6.count == 2)

        print("\n\(passed) passed, \(failed) failed")
        exit(failed == 0 ? 0 : 1)
    }
}
