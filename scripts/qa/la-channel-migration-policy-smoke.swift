//
//  la-channel-migration-policy-smoke.swift
//  레거시/구채널 → broadcast 채널 마이그레이션 정책 회귀 스모크 —
//  ios/App/App/ChannelMigrationPolicy.swift 를 고정한다.
//
//  배경(2026-07-23 파서 장애): 채널이 경기 시작 후 생성되면 그날 카드는 전부 레거시로
//  태어나고, 앱을 열어도 복구가 안 됐다(rescan이 토큰 재등록만 함). 본 정책 회귀 기준:
//   ① 게이트 — iOS<18 / 라이브 카드 없음 / in-flight = no-op
//   ② active 채널 확보 시에만 migrate — 재생성 실패 안전은 실행측 순서(request 성공 후
//     end)가 보장한다
//   ③ 채널 부재·GET 일시 실패 = 폐기 아닌 재시도 유보(채널이 늦게 생기는 케이스 커버)
//  라운드2(삼순 R2 blocker 반영):
//   ④ background request 0 — foreground-active 아니면 preflight/recheck 모두 차단
//   ⑤ 경합 시 채널 카드 생존 — start() 스윕은 채널 카드 최우선 보존, 카드 있으면 keep ≠ nil(0장 불가)
//   ⑦ fallback 차단 — 신규 start는 채널 카드만: 채널 미준비/조회 실패 = 시작 유보(레거시 금지)
//  라운드4(삼순 R4 blocker 반영 — game 단위 reconcile):
//   ⑧ 영구 캐시 제거 — foreground마다 game 단위 재검사. B→C 연속 채널 교체도 다음 foreground가 잡음
//   ⑨ [현재 B, 구채널 A/레거시] 순서 무관 — 현재 채널 1장만 남기고 비현재 전부 정리(카드 0장 불가)
//   ⑩ current-first/stale-first 배선 — reconcile은 현재 확보(adopt/request) 후에만 비현재 end index 반환
//  라운드5(삼순 R5 blocker 반영 — orchestration 실배선 회귀):
//   ⑪ ChannelMigrationOrchestrator(Controller가 그대로 소비하는 조립 코드)를 mock
//     request/end/fetch 주입으로 *실행* — fetch 중 background 전환 시 request/end 0,
//     current-first 순서(request 성공 후 stale end), request 실패 시 end 0, B→C 수렴 고정
//
//  라운드6(삼순 R6 blocker 반영 — fetch 후 fresh snapshot):
//   ⑬ plan/request/end는 fetch *완료 후* 재-enumerate한 live/active 카드 스냅샷 기준 —
//     fetch 중 카드 전부 dismiss/ended면 request 0 · end 0(유령 카드 부활 금지)
//  라운드7(삼순 R7 blocker 반영 — effect 직전 최종 foreground 게이트):
//   ⑭ fresh enumerate를 await하는 동안 background 전환돼도 request/adopt/end 전부 0 —
//     effect 직전 마지막 suspension point 이후 foreground를 한 번 더 재확인한다
//
//  실행: npm run qa:la-migration-policy (macOS/swiftc 필요)
//

import Foundation

@main
struct LaChannelMigrationPolicySmoke {
    static var passed = 0
    static var failed = 0

    static func check(_ name: String, _ cond: Bool) {
        if cond { passed += 1; print("  PASS \(name)") }
        else { failed += 1; print("❌ FAIL \(name)") }
    }

    static func main() async {
        typealias P = ChannelMigrationPolicy
        typealias O = ChannelMigrationOrchestrator

        // ── ① preflight 게이트 표 (R4: game 단위 — 영구 성공 캐시 제거, 라이브 카드 유무 게이트) ──
        print("[① preflight — 포그·라이브카드 존재·비-inflight일 때 진행(영구 캐시 없음)]")
        check("포그 + 라이브 카드 존재 + 비-inflight = proceed",
              P.preflight(osAtLeast18: true, isForegroundActive: true,
                          gameHasLiveCard: true, inFlight: false) == .proceed)
        check("iOS 18 미만 = skip(OS)",
              P.preflight(osAtLeast18: false, isForegroundActive: true,
                          gameHasLiveCard: true, inFlight: false) == .skipOsUnsupported)
        check("game에 라이브 active 카드 없음(scheduled/final만) = skip",
              P.preflight(osAtLeast18: true, isForegroundActive: true,
                          gameHasLiveCard: false, inFlight: false) == .skipNoLiveCard)
        check("같은 game reconcile 진행 중(in-flight) = skip(동시 중복 방지)",
              P.preflight(osAtLeast18: true, isForegroundActive: true,
                          gameHasLiveCard: true, inFlight: true) == .skipInFlight)
        // R4 핵심: 영구 캐시(alreadyMigrated) 인자 자체가 사라져 "한 번 수렴하면 skip"이 불가.
        check("R4: 매 foreground 동일 입력 = 항상 proceed(영구 skip 경로 없음)",
              P.preflight(osAtLeast18: true, isForegroundActive: true,
                          gameHasLiveCard: true, inFlight: false) == .proceed
              && P.preflight(osAtLeast18: true, isForegroundActive: true,
                             gameHasLiveCard: true, inFlight: false) == .proceed)

        // ── ② reconcile 기본 판정 — 카드 marker 배열 × 현재 active 채널 대조 ──
        print("[② reconcile — 레거시/구채널 → 현재 B 복구·현재 수렴·유보]")
        check("레거시(marker nil) + active B → requestCurrent(B) [현재 B 카드 없음]",
              P.reconcile(cardChannelIds: [nil], fetch: .active("chB"))
                  == .requestCurrent(channelId: "chB", end: [0]))
        check("구채널 marker A + active B → requestCurrent(B), A(idx0) end [A≠B 복구]",
              P.reconcile(cardChannelIds: ["chA"], fetch: .active("chB"))
                  == .requestCurrent(channelId: "chB", end: [0]))
        check("marker B + active B → adoptCurrent(keep 0, end 없음) [수렴, request 0]",
              P.reconcile(cardChannelIds: ["chB"], fetch: .active("chB"))
                  == .adoptCurrent(keep: 0, end: []))
        check("active 채널 부재 → retry(카드 유지, 채널 늦게 생길 수 있음 — 7/23)",
              P.reconcile(cardChannelIds: [nil], fetch: .active(nil)) == .retryNextForeground)
        check("구채널 A + active 부재 → retry(A 유지 — 재생성 불가로 end 금지, 카드 손실 방지)",
              P.reconcile(cardChannelIds: ["chA"], fetch: .active(nil)) == .retryNextForeground)
        check("GET network/5xx/파싱 실패 → retry(확정 아님, 전 카드 유지)",
              P.reconcile(cardChannelIds: ["chA"], fetch: .retryableFailure) == .retryNextForeground)

        // ── ③ 시나리오: 7/23 파서 장애 — 채널 늦은 생성 후 앱 오픈 시 복구 ──
        print("[③ 시나리오 — 18:00 오픈(채널 없음) no-op → 19:30 오픈(채널 있음) migrate]")
        check("18:00 reconcile(레거시 + 채널 없음) = retry — 카드 유지",
              P.reconcile(cardChannelIds: [nil],
                          fetch: ChannelAckPolicy.classifyFetch(status: 200, parsed: true, channelId: nil))
                  == .retryNextForeground)
        check("19:30 reconcile(레거시 + 채널 chA 생성됨) = requestCurrent(chA)",
              P.reconcile(cardChannelIds: [nil],
                          fetch: ChannelAckPolicy.classifyFetch(status: 200, parsed: true, channelId: "chA"))
                  == .requestCurrent(channelId: "chA", end: [0]))
        // 재생성 성공 → 새 카드 marker(chA) 보유 → 이후 reconcile은 adoptCurrent(no-op 수렴).
        check("마이그레이션 후 [marker chA] rescan = adoptCurrent(keep 0, end 없음)",
              P.reconcile(cardChannelIds: ["chA"], fetch: .active("chA"))
                  == .adoptCurrent(keep: 0, end: []))

        // ── ④ R2 blocker③ — background에서 local Activity.request() 0건 ──
        print("[④ foreground 게이트 — silent wake/background = request 0건]")
        check("background(silent wake) preflight = skipNotForeground — 다른 조건 충족해도 차단",
              P.preflight(osAtLeast18: true, isForegroundActive: false,
                          gameHasLiveCard: true, inFlight: false) == .skipNotForeground)
        check("foreground 게이트가 라이브카드 게이트보다 우선(순서 고정)",
              P.preflight(osAtLeast18: true, isForegroundActive: false,
                          gameHasLiveCard: false, inFlight: false) == .skipNotForeground)
        check("직렬 구간 recheck — request 직전 background 전환 = abort(request 0)",
              P.recheck(isForegroundActive: false, legacyStillActive: true) == .abortBackground)
        check("recheck — background 판정이 legacy 존재 판정보다 우선",
              P.recheck(isForegroundActive: false, legacyStillActive: false) == .abortBackground)
        check("recheck — 락 대기 중 카드가 이미 정리됨(0장) = abort(할 일 없음)",
              P.recheck(isForegroundActive: true, legacyStillActive: false) == .abortLegacyGone)
        check("recheck — foreground + 카드 생존 = proceed",
              P.recheck(isForegroundActive: true, legacyStillActive: true) == .proceed)

        // ── ⑤ R2 blocker① — start() 스윕 경합: 채널 카드 생존·카드 0장 불가 ──
        print("[⑤ start() 보존 선택 — 채널 카드 최우선, 카드 있으면 keep ≠ nil]")
        check("[legacy, channel] → 채널 카드(idx 1) 보존 — migration 새 카드를 start가 안 죽임",
              P.keepIndex(hasChannelMarker: [false, true]) == 1)
        check("[channel, legacy] → 채널 카드(idx 0) 보존",
              P.keepIndex(hasChannelMarker: [true, false]) == 0)
        check("[legacy만] → 첫 카드 보존(카드 0장 불가)",
              P.keepIndex(hasChannelMarker: [false, false]) == 0)
        check("카드 1장이라도 있으면 반드시 보존(keep ≠ nil)",
              P.keepIndex(hasChannelMarker: [false]) == 0 && P.keepIndex(hasChannelMarker: [true]) == 0)
        check("카드 없음일 때만 nil",
              P.keepIndex(hasChannelMarker: []) == nil)

        // ── ⑦ R2 blocker④ — 신규 start 레거시 fallback 차단 ──
        print("[⑦ start fallback 차단 — 채널 미준비 = 시작 유보, 레거시 시작 금지]")
        check("자기 env active 채널 확보 → 채널 카드로만 시작",
              P.startDecision(.active("chX")) == .startChannelCard("chX"))
        check("definitive 채널 부재 → 시작 유보(레거시 fallback 금지 — 7/23 사고 입구 차단)",
              P.startDecision(.active(nil)) == .deferStart)
        check("GET network/5xx/파싱 실패 → 시작 유보(fallback 금지)",
              P.startDecision(.retryableFailure) == .deferStart)

        // ── ⑧ R4 blocker① — 영구 캐시 제거: B→C 연속 채널 교체 재검사 ──
        print("[⑧ B→C 연속 교체 — foreground마다 game 단위 재검사(영구 skip 없음)]")
        // 1차 foreground: 채널 A로 태어난 레거시 → 현재 B로 수렴(카드 marker B).
        check("t0: [marker B] + active B = adopt(수렴)",
              P.reconcile(cardChannelIds: ["chB"], fetch: .active("chB"))
                  == .adoptCurrent(keep: 0, end: []))
        // 채널이 B→C로 다시 교체됨. 이전 구현은 gameId 영구 캐시로 이 카드를 재검사 안 함.
        // R4: 다음 foreground에서 marker B ≠ active C → requestCurrent(C), B(idx0) end.
        check("t1: [marker B] + active C = requestCurrent(C), B end [영구 skip이면 놓쳤을 케이스]",
              P.reconcile(cardChannelIds: ["chB"], fetch: .active("chC"))
                  == .requestCurrent(channelId: "chC", end: [0]))
        // C로 재생성 후: marker C == active C → 수렴.
        check("t2: [marker C] + active C = adopt(수렴)",
              P.reconcile(cardChannelIds: ["chC"], fetch: .active("chC"))
                  == .adoptCurrent(keep: 0, end: []))

        // ── ⑨ R4 blocker② — [현재 B, 구채널 A/레거시] 순서 무관 stale 정리 ──
        print("[⑨ 카드 순서 무관 — 현재 B 1장만 남기고 비현재 전부 end]")
        // [현재 B, 구채널 A] 순서: 이전 activity-단위 구현은 B만 ACK하고 A 영구 잔존.
        check("[현재 B(idx0), 구채널 A(idx1)] + active B → adopt(keep 0), A(idx1) end",
              P.reconcile(cardChannelIds: ["chB", "chA"], fetch: .active("chB"))
                  == .adoptCurrent(keep: 0, end: [1]))
        // 역순 [구채널 A, 현재 B]도 동일하게 B 보존·A 정리.
        check("[구채널 A(idx0), 현재 B(idx1)] + active B → adopt(keep 1), A(idx0) end",
              P.reconcile(cardChannelIds: ["chA", "chB"], fetch: .active("chB"))
                  == .adoptCurrent(keep: 1, end: [0]))
        // [현재 B, 레거시 nil, 구채널 A] 3장 → B 보존, 나머지(1,2) 전부 end.
        check("[현재 B, 레거시 nil, 구채널 A] + active B → adopt(keep 0), end [1,2]",
              P.reconcile(cardChannelIds: ["chB", nil, "chA"], fetch: .active("chB"))
                  == .adoptCurrent(keep: 0, end: [1, 2]))
        // 중복 현재-채널 카드 [B, B] → firstIndex만 keep, 나머지 B(idx1) end(1장으로 수렴).
        check("[현재 B, 중복 B] + active B → adopt(keep 0), 중복 B(idx1) end(1장 수렴)",
              P.reconcile(cardChannelIds: ["chB", "chB"], fetch: .active("chB"))
                  == .adoptCurrent(keep: 0, end: [1]))
        // 현재 채널 카드 부재 [레거시 nil, 구채널 A] → requestCurrent(B), 전부(0,1) end.
        check("[레거시 nil, 구채널 A] + active B(현재카드 없음) → requestCurrent(B), end [0,1]",
              P.reconcile(cardChannelIds: [nil, "chA"], fetch: .active("chB"))
                  == .requestCurrent(channelId: "chB", end: [0, 1]))

        // ── ⑩ current-first/stale-first 배선 — 수렴 목표: 1장/0장 ──
        print("[⑩ 수렴 목표 — foreground 1회 후 현재 채널 1장 / 비현재 0장]")
        // adopt 경로: keep 1장 + end N장 → end 후 현재 1장만 남음(합집합 = 전체, keep∉end).
        do {
            let plan = P.reconcile(cardChannelIds: ["chB", "chA", nil], fetch: .active("chB"))
            if case let .adoptCurrent(keep, end) = plan {
                check("adopt: keep은 end에 미포함(현재 카드 보존)", !end.contains(keep))
                check("adopt: keep+end = 전체 인덱스(비현재 전부 정리 = 0장 수렴)",
                      Set([keep] + end) == Set(0..<3) && end.count == 2)
            } else { check("adopt 경로 진입", false) }
        }
        // request 경로: end = 전체(현재 카드 없음). 실행측은 request 성공 후에만 이 end 수행 →
        // 성공 시 새 카드 1장 + 스냅샷 전부 end = 1장/0장. 실패 시 실행측이 end 스킵(전 카드 유지).
        do {
            let plan = P.reconcile(cardChannelIds: [nil, "chA"], fetch: .active("chB"))
            if case let .requestCurrent(channelId, end) = plan {
                check("request: 대상 채널 = 현재 active(B)", channelId == "chB")
                check("request: end = 전체 인덱스(현재 카드 없음 → 재생성 후 전부 정리)",
                      Set(end) == Set(0..<2))
            } else { check("request 경로 진입", false) }
        }
        // retry 경로: 어떤 카드도 end하지 않음(계획 자체가 no-op) → 카드 손실 0.
        check("retry: 계획이 no-op(비현재 end index 없음 — 카드 손실 0)",
              P.reconcile(cardChannelIds: ["chA", nil], fetch: .active(nil)) == .retryNextForeground)

        // ── ⑪ R5 — orchestration 실배선 회귀 (mock request/end/fetch 주입 실행) ──
        print("[⑪ R5 orchestration — Controller 조립 코드를 mock effect로 실행]")
        // (a) R5 blocker① — fetch를 await하는 동안 background 전환: request/end/adopt 0, 전 카드 유지.
        do {
            var fgCalls = 0
            var events: [String] = []
            let outcome = await O.reconcile(
                enumerateCards: { [nil, "chA"] },
                isForegroundActive: { fgCalls += 1; return fgCalls == 1 },   // fetch 전 active → fetch 후 background
                fetchActiveChannel: { events.append("fetch"); return .active("chB") },
                adoptCurrent: { events.append("adopt:\($0)") },
                requestCurrent: { events.append("request:\($0)"); return true },
                endCard: { events.append("end:\($0)") }
            )
            check("R5(a): fetch 중 background 전환 = abortBackgroundPostFetch",
                  outcome == .abortBackgroundPostFetch)
            check("R5(a): request 0 · end 0 · adopt 0 (전 카드 유지 = fetch만 실행)",
                  events == ["fetch"])
            check("R5(a): foreground 재게이트가 fetch 이후 실제 재평가됨(2회 조회)",
                  fgCalls == 2)
        }
        // (b) 직렬 구간 진입 전부터 background — fetch 자체도 0회(기존 R2 계약 유지).
        do {
            var events: [String] = []
            let outcome = await O.reconcile(
                enumerateCards: { [nil] },
                isForegroundActive: { false },
                fetchActiveChannel: { events.append("fetch"); return .active("chB") },
                adoptCurrent: { events.append("adopt:\($0)") },
                requestCurrent: { events.append("request:\($0)"); return true },
                endCard: { events.append("end:\($0)") }
            )
            check("R5(b): 진입 시점 background = abortBackgroundPreFetch · effect 0(fetch도 0)",
                  outcome == .abortBackgroundPreFetch && events.isEmpty)
        }
        // (c) 정상 흐름 current-first 순서 — request 성공 *후*에만 stale end(순서 고정).
        do {
            var events: [String] = []
            let outcome = await O.reconcile(
                enumerateCards: { [nil, "chA"] },   // 레거시 + 구채널 A, 현재 B 카드 없음
                isForegroundActive: { true },
                fetchActiveChannel: { events.append("fetch"); return .active("chB") },
                adoptCurrent: { events.append("adopt:\($0)") },
                requestCurrent: { events.append("request:\($0)"); return true },
                endCard: { events.append("end:\($0)") }
            )
            check("R5(c): fetch → request(B) 성공 → 그 다음에만 스냅샷 전 카드 end (current-first)",
                  events == ["fetch", "request:chB", "end:0", "end:1"])
            check("R5(c): outcome = recreated(B, ended [0,1])",
                  outcome == .recreated(channelId: "chB", ended: [0, 1]))
        }
        // (d) request 실패 — end 0회, 전 카드 유지(카드만 죽고 끝나는 경로 없음).
        do {
            var events: [String] = []
            let outcome = await O.reconcile(
                enumerateCards: { [nil, "chA"] },
                isForegroundActive: { true },
                fetchActiveChannel: { events.append("fetch"); return .active("chB") },
                adoptCurrent: { events.append("adopt:\($0)") },
                requestCurrent: { events.append("request:\($0)"); return false },   // Activity.request throw 상당
                endCard: { events.append("end:\($0)") }
            )
            check("R5(d): request 실패 = requestFailedKeepAll · end 0(전 카드 유지)",
                  outcome == .requestFailedKeepAll && events == ["fetch", "request:chB"])
        }
        // (e) [현재 B, 구채널 A] adopt 경로 — 재-ack 후 비현재 end, request 0. 역순도 동일.
        do {
            var events: [String] = []
            let outcome = await O.reconcile(
                enumerateCards: { ["chB", "chA"] },
                isForegroundActive: { true },
                fetchActiveChannel: { events.append("fetch"); return .active("chB") },
                adoptCurrent: { events.append("adopt:\($0)") },
                requestCurrent: { events.append("request:\($0)"); return true },
                endCard: { events.append("end:\($0)") }
            )
            check("R5(e): [B,A]+active B = adopt(keep 0) → A end · request 0",
                  outcome == .adopted(keep: 0, ended: [1])
                  && events == ["fetch", "adopt:0", "end:1"])
            var eventsRev: [String] = []
            let outcomeRev = await O.reconcile(
                enumerateCards: { ["chA", "chB"] },
                isForegroundActive: { true },
                fetchActiveChannel: { eventsRev.append("fetch"); return .active("chB") },
                adoptCurrent: { eventsRev.append("adopt:\($0)") },
                requestCurrent: { eventsRev.append("request:\($0)"); return true },
                endCard: { eventsRev.append("end:\($0)") }
            )
            check("R5(e): 역순 [A,B]+active B = adopt(keep 1) → A(idx0) end · request 0",
                  outcomeRev == .adopted(keep: 1, ended: [0])
                  && eventsRev == ["fetch", "adopt:1", "end:0"])
        }
        // (f) foreground1 B → foreground2 C — mock 카드 저장소로 2회 실행, 매번 현재 1장/비현재 0장 수렴.
        do {
            var nextId = 0
            var cards: [(id: Int, ch: String?)] = [(id: -1, ch: nil)]   // t0: 레거시 1장
            func runForeground(active: String) async -> O.Outcome {
                var snapshot: [(id: Int, ch: String?)] = []   // Controller의 liveCards 상당 — enumerate마다 갱신(R6)
                return await O.reconcile(
                    enumerateCards: { snapshot = cards; return snapshot.map { $0.ch } },
                    isForegroundActive: { true },
                    fetchActiveChannel: { .active(active) },
                    adoptCurrent: { _ in },
                    requestCurrent: { ch in cards.append((id: nextId, ch: ch)); nextId += 1; return true },
                    endCard: { idx in cards.removeAll { $0.id == snapshot[idx].id } }
                )
            }
            let o1 = await runForeground(active: "chB")
            let afterB = cards
            let o2 = await runForeground(active: "chC")
            let afterC = cards
            let o3 = await runForeground(active: "chC")   // 수렴 후 재실행 = adopt no-op
            check("R5(f): foreground1(active B) = recreated → 카드 [B] 1장 수렴",
                  o1 == .recreated(channelId: "chB", ended: [0])
                  && afterB.map { $0.ch } == ["chB"])
            check("R5(f): foreground2(active C) = recreated → B end, 카드 [C] 1장 수렴(영구 skip 없음)",
                  o2 == .recreated(channelId: "chC", ended: [0])
                  && afterC.map { $0.ch } == ["chC"])
            check("R5(f): 수렴 후 재실행 = adopt(keep 0, end 없음) — request/end 0 no-op",
                  o3 == .adopted(keep: 0, ended: []) && cards.map { $0.ch } == ["chC"])
        }
        // (g) 채널 부재/GET 실패 — orchestration 레벨에서도 effect 0(전 카드 유지) · 빈 카드 = legacyGone.
        do {
            var events: [String] = []
            let retry = await O.reconcile(
                enumerateCards: { ["chA"] },
                isForegroundActive: { true },
                fetchActiveChannel: { events.append("fetch"); return .retryableFailure },
                adoptCurrent: { events.append("adopt:\($0)") },
                requestCurrent: { events.append("request:\($0)"); return true },
                endCard: { events.append("end:\($0)") }
            )
            check("R5(g): GET 실패 = retryNextForeground · request/end 0",
                  retry == .retryNextForeground && events == ["fetch"])
            let gone = await O.reconcile(
                enumerateCards: { [] },
                isForegroundActive: { true },
                fetchActiveChannel: { events.append("fetch2"); return .active("chB") },
                adoptCurrent: { _ in },
                requestCurrent: { _ in true },
                endCard: { _ in }
            )
            check("R5(g): 카드 이미 정리(0장) = abortLegacyGone · fetch 0",
                  gone == .abortLegacyGone && !events.contains("fetch2"))
        }

        // ── ⑬ R6 — fetch 중 카드 dismiss/ended: plan은 fetch 후 fresh snapshot 기준 ──
        print("")
        print("[⑬ R6 — fetch 중 카드 dismiss/ended → fresh snapshot으로 plan(유령 카드 부활 금지)]")
        // (h) fetch 중 카드 전부 dismiss/ended — request 0 · end 0(no-op). stale snapshot이면
        //     requestCurrent(chB)로 새 채널 카드를 되살렸을 케이스.
        do {
            var events: [String] = []
            var enumCalls = 0
            let outcome = await O.reconcile(
                enumerateCards: {
                    enumCalls += 1; events.append("enum\(enumCalls)")
                    return enumCalls == 1 ? [nil, "chA"] : []   // fetch 중 전부 dismiss/ended
                },
                isForegroundActive: { true },
                fetchActiveChannel: { events.append("fetch"); return .active("chB") },
                adoptCurrent: { events.append("adopt:\($0)") },
                requestCurrent: { events.append("request:\($0)"); return true },
                endCard: { events.append("end:\($0)") }
            )
            check("R6(h): fetch 중 카드 전부 dismiss/ended = cardsGonePostFetch",
                  outcome == .cardsGonePostFetch)
            check("R6(h): request 0 · end 0 · adopt 0 (유령 카드 부활 금지)",
                  events == ["enum1", "fetch", "enum2"])
            check("R6(h): plan이 fetch *후* 재-enumerate 스냅샷 기준(enumerate 2회)",
                  enumCalls == 2)
        }
        // (i) fetch 중 일부만 dismiss — fresh snapshot idx로 plan: 남은 현재 카드 adopt,
        //     stale idx end 0(사라진 카드 end 시도 없음).
        do {
            var events: [String] = []
            var enumCalls = 0
            let outcome = await O.reconcile(
                enumerateCards: {
                    enumCalls += 1
                    return enumCalls == 1 ? [nil, "chB"] : ["chB"]   // fetch 중 레거시(idx0)만 dismiss
                },
                isForegroundActive: { true },
                fetchActiveChannel: { events.append("fetch"); return .active("chB") },
                adoptCurrent: { events.append("adopt:\($0)") },
                requestCurrent: { events.append("request:\($0)"); return true },
                endCard: { events.append("end:\($0)") }
            )
            check("R6(i): fetch 중 일부 dismiss → fresh snapshot idx로 adopt(keep 0) · end 0",
                  outcome == .adopted(keep: 0, ended: [])
                  && events == ["fetch", "adopt:0"])
        }

        // ── ⑭ R7 — fresh enumerate 중 background 전환: effect 직전 최종 foreground 게이트 ──
        print("")
        print("[⑭ R7 — fresh enumerate 중 background 전환 → request/adopt/end 전부 0]")
        // (j) fg는 fetch 전(1)·fetch 후(2)엔 active, fresh enumerate를 await하는 동안 background
        //     전환 → effect 직전 게이트(3번째 조회)가 잡는다. 게이트가 없으면 stale하지 않은
        //     fresh snapshot으로도 background에서 request:chB → end:0가 실행됐다(R5 계약 재붕괴).
        do {
            var events: [String] = []
            var fgCalls = 0
            var enumCalls = 0
            let outcome = await O.reconcile(
                enumerateCards: {
                    enumCalls += 1; events.append("enum\(enumCalls)")
                    return [nil, "chA"]   // 카드는 그대로 — background 전환만 발생
                },
                isForegroundActive: { fgCalls += 1; return fgCalls <= 2 },   // 3번째(effect 직전) = background
                fetchActiveChannel: { events.append("fetch"); return .active("chB") },
                adoptCurrent: { events.append("adopt:\($0)") },
                requestCurrent: { events.append("request:\($0)"); return true },
                endCard: { events.append("end:\($0)") }
            )
            check("R7(j): fresh enumerate 중 background 전환 = abortBackgroundPreEffect",
                  outcome == .abortBackgroundPreEffect)
            check("R7(j): request 0 · adopt 0 · end 0 (전 카드 유지 = enum·fetch만 실행)",
                  events == ["enum1", "fetch", "enum2"])
            check("R7(j): foreground가 effect 직전까지 3회 재평가됨(마지막 게이트 실재)",
                  fgCalls == 3)
        }
        // (k) adopt 경로도 동일 — enumerate 중 background면 adopt/end 0.
        do {
            var events: [String] = []
            var fgCalls = 0
            let outcome = await O.reconcile(
                enumerateCards: { ["chB", "chA"] },
                isForegroundActive: { fgCalls += 1; return fgCalls <= 2 },
                fetchActiveChannel: { events.append("fetch"); return .active("chB") },
                adoptCurrent: { events.append("adopt:\($0)") },
                requestCurrent: { events.append("request:\($0)"); return true },
                endCard: { events.append("end:\($0)") }
            )
            check("R7(k): adopt 경로도 effect 직전 게이트 — adopt 0 · end 0",
                  outcome == .abortBackgroundPreEffect && events == ["fetch"])
        }
        // (l) 정상 흐름(계속 foreground)은 R7 게이트 추가 후에도 그대로 통과(회귀 없음).
        do {
            var fgCalls = 0
            var events: [String] = []
            let outcome = await O.reconcile(
                enumerateCards: { [nil, "chA"] },
                isForegroundActive: { fgCalls += 1; return true },
                fetchActiveChannel: { events.append("fetch"); return .active("chB") },
                adoptCurrent: { events.append("adopt:\($0)") },
                requestCurrent: { events.append("request:\($0)"); return true },
                endCard: { events.append("end:\($0)") }
            )
            check("R7(l): 계속 foreground = 기존 current-first 흐름 그대로(recreated)",
                  outcome == .recreated(channelId: "chB", ended: [0, 1])
                  && events == ["fetch", "request:chB", "end:0", "end:1"])
        }

        print("")
        print("결과: PASS \(passed) / FAIL \(failed)")
        exit(failed == 0 ? 0 : 1)
    }
}
