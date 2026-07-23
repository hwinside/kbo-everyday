//
//  la-channel-migration-policy-smoke.swift
//  레거시 → broadcast 채널 마이그레이션 정책 회귀 스모크 —
//  ios/App/App/ChannelMigrationPolicy.swift 를 고정한다.
//
//  배경(2026-07-23 파서 장애): 채널이 경기 시작 후 생성되면 그날 카드는 전부 레거시로
//  태어나고, 앱을 열어도 복구가 안 됐다(rescan이 토큰 재등록만 함). 본 정책 회귀 기준:
//   ① 게이트 — iOS<18 / 이미 채널 카드 / 비라이브 / 성공 완료 / in-flight = no-op
//   ② 채널 부재·GET 일시 실패 = 폐기 아닌 재시도 유보(채널이 늦게 생기는 케이스 커버)
//   ③ active 채널 확보 시에만 migrate — 재생성 실패 안전은 실행측 순서(request 성공 후
//     end)가 보장하며, 실패는 마이그레이션 완료로 마킹되지 않아 다음 포그라운드 재시도
//  라운드2(삼순 R2 blocker 반영):
//   ④ background request 0 — foreground-active 아니면 preflight/recheck 모두 차단
//   ⑤ 경합 시 채널 카드 생존 — start() 스윕은 채널 카드 최우선 보존, 카드 있으면 keep ≠ nil(0장 불가)
//   ⑥ 중복 채널 방지 — 같은 경기 active 채널 카드 존재 시 request 없이 legacy만 정리
//   ⑦ fallback 차단 — 신규 start는 채널 카드만: 채널 미준비/조회 실패 = 시작 유보(레거시 금지)
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

    static func main() {
        typealias P = ChannelMigrationPolicy

        // ── ① preflight 게이트 표 ──
        print("[① preflight — 레거시·라이브·비중복일 때만 진행]")
        check("레거시 + 라이브 + 첫 시도 = proceed",
              P.preflight(osAtLeast18: true, isForegroundActive: true, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .proceed)
        check("iOS 18 미만 = skip(OS)",
              P.preflight(osAtLeast18: false, isForegroundActive: true, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .skipOsUnsupported)
        check("marker 보유(이미 채널 카드) = skip",
              P.preflight(osAtLeast18: true, isForegroundActive: true, hasChannelMarker: true, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .skipAlreadyChannel)
        check("비라이브(scheduled/final/ended) = skip",
              P.preflight(osAtLeast18: true, isForegroundActive: true, hasChannelMarker: false, isLive: false,
                          alreadyMigrated: false, inFlight: false) == .skipNotLive)
        check("같은 경기 성공 완료 = skip(경기당 1회)",
              P.preflight(osAtLeast18: true, isForegroundActive: true, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: true, inFlight: false) == .skipAlreadyMigrated)
        check("같은 경기 in-flight = skip(동시 중복 방지)",
              P.preflight(osAtLeast18: true, isForegroundActive: true, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: false, inFlight: true) == .skipInFlight)
        check("marker 게이트가 live 게이트보다 우선(채널 카드는 상태 무관 no-op)",
              P.preflight(osAtLeast18: true, isForegroundActive: true, hasChannelMarker: true, isLive: false,
                          alreadyMigrated: false, inFlight: false) == .skipAlreadyChannel)

        // ── ② fetch 판정 — ChannelAckPolicy.ChannelFetch 재사용 ──
        print("[② fetch 판정 — 채널 부재/일시 실패는 재시도 유보(폐기 금지)]")
        check("active 채널 확보 → migrate(그 채널로 재생성)",
              P.onFetch(.active("ch1")) == .migrate("ch1"))
        check("definitive 채널 부재 → retry(채널이 늦게 생길 수 있음 — 7/23 케이스)",
              P.onFetch(.active(nil)) == .retryNextForeground)
        check("GET network/5xx/파싱 실패 → retry(확정 아님)",
              P.onFetch(.retryableFailure) == .retryNextForeground)

        // ── ③ 시나리오: 7/23 파서 장애 재현 — 채널 늦은 생성 후 앱 오픈 시 복구 ──
        print("[③ 시나리오 — 18:00 오픈(채널 없음) no-op → 19:30 오픈(채널 있음) migrate]")
        // 18:00 앱 오픈: 레거시 라이브 카드, 채널 아직 없음
        check("18:00 preflight = proceed(시도는 함)",
              P.preflight(osAtLeast18: true, isForegroundActive: true, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .proceed)
        check("18:00 fetch(채널 없음) = retry — 레거시 유지·완료 마킹 없음",
              P.onFetch(ChannelAckPolicy.classifyFetch(status: 200, parsed: true, channelId: nil))
                  == .retryNextForeground)
        // 19:30 앱 오픈: alreadyMigrated=false 그대로(실패는 마킹 안 함) → 재시도 허용
        check("19:30 preflight = proceed(재시도 허용)",
              P.preflight(osAtLeast18: true, isForegroundActive: true, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .proceed)
        check("19:30 fetch(채널 생성됨) = migrate",
              P.onFetch(ChannelAckPolicy.classifyFetch(status: 200, parsed: true, channelId: "chA"))
                  == .migrate("chA"))
        // 재생성 성공 → 새 activity는 marker 보유 → 이후 rescan은 항상 no-op
        check("마이그레이션 후 새 카드(marker 보유) rescan = skip",
              P.preflight(osAtLeast18: true, isForegroundActive: true, hasChannelMarker: true, isLive: true,
                          alreadyMigrated: true, inFlight: false) == .skipAlreadyChannel)

        // ── ④ R2 blocker③ — background에서 local Activity.request() 0건 ──
        print("[④ foreground 게이트 — silent wake/background = request 0건]")
        check("background(silent wake) preflight = skipNotForeground — 다른 조건 충족해도 차단",
              P.preflight(osAtLeast18: true, isForegroundActive: false, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .skipNotForeground)
        check("foreground 게이트가 marker/live 게이트보다 우선(순서 고정)",
              P.preflight(osAtLeast18: true, isForegroundActive: false, hasChannelMarker: true, isLive: false,
                          alreadyMigrated: false, inFlight: false) == .skipNotForeground)
        check("직렬 구간 recheck — request 직전 background 전환 = abort(request 0)",
              P.recheck(isForegroundActive: false, legacyStillActive: true) == .abortBackground)
        check("recheck — background 판정이 legacy 존재 판정보다 우선",
              P.recheck(isForegroundActive: false, legacyStillActive: false) == .abortBackground)
        check("recheck — 락 대기 중 legacy가 이미 정리됨 = abort(할 일 없음)",
              P.recheck(isForegroundActive: true, legacyStillActive: false) == .abortLegacyGone)
        check("recheck — foreground + legacy 생존 = proceed",
              P.recheck(isForegroundActive: true, legacyStillActive: true) == .proceed)

        // ── ⑤ R2 blocker① — start() 스윕 경합: 채널 카드 생존·카드 0장 불가 ──
        print("[⑤ start() 보존 선택 — 채널 카드 최우선, 카드 있으면 keep ≠ nil]")
        check("[legacy, channel] → 채널 카드(idx 1) 보존 — migration 새 카드를 start가 안 죽임",
              P.keepIndex(hasChannelMarker: [false, true]) == 1)
        check("[channel, legacy] → 채널 카드(idx 0) 보존",
              P.keepIndex(hasChannelMarker: [true, false]) == 0)
        check("[legacy, channel, channel] → 첫 채널 카드(idx 1) 보존",
              P.keepIndex(hasChannelMarker: [false, true, true]) == 1)
        check("[legacy만] → 첫 카드 보존(카드 0장 불가)",
              P.keepIndex(hasChannelMarker: [false, false]) == 0)
        check("카드 1장이라도 있으면 반드시 보존(keep ≠ nil)",
              P.keepIndex(hasChannelMarker: [false]) == 0 && P.keepIndex(hasChannelMarker: [true]) == 0)
        check("카드 없음일 때만 nil",
              P.keepIndex(hasChannelMarker: []) == nil)

        // ── ⑥ R2 blocker② — 중복 채널 카드 방지 ──
        print("[⑥ 중복 채널 방지 — 같은 경기 채널 카드 있으면 request 없이 legacy만 정리]")
        check("active 채널 카드 존재 → adopt(신규 request 0건)",
              P.migrateMode(hasActiveSameGameChannelCard: true) == .adoptExistingChannelCard)
        check("채널 카드 없음 → requestNewChannelCard(fetch 후 request)",
              P.migrateMode(hasActiveSameGameChannelCard: false) == .requestNewChannelCard)

        // ── ⑦ R2 blocker④ — 신규 start 레거시 fallback 차단 ──
        print("[⑦ start fallback 차단 — 채널 미준비 = 시작 유보, 레거시 시작 금지]")
        check("자기 env active 채널 확보 → 채널 카드로만 시작",
              P.startDecision(.active("chX")) == .startChannelCard("chX"))
        check("definitive 채널 부재 → 시작 유보(레거시 fallback 금지 — 7/23 사고 입구 차단)",
              P.startDecision(.active(nil)) == .deferStart)
        check("GET network/5xx/파싱 실패 → 시작 유보(fallback 금지)",
              P.startDecision(.retryableFailure) == .deferStart)
        check("classifyFetch(200, 채널 없음) 경유도 동일하게 유보",
              P.startDecision(ChannelAckPolicy.classifyFetch(status: 200, parsed: true, channelId: nil))
                  == .deferStart)

        // ── ⑧ 시나리오 — 앱 오픈 경합(migration 직후 start 개입)에서 최종 채널 1·레거시 0·손실 0 ──
        print("[⑧ 시나리오 — migration↔start 경합에서 채널 카드 생존]")
        // migration이 채널 카드 생성 직후(legacy end 전) start()가 끼어든 상황:
        // 카드 = [legacy, channel] — 직렬 큐로 인터리브 자체가 불가하지만, 설사 순서가 어긋나도
        // start 스윕은 채널 카드를 보존하고 legacy만 종료한다.
        check("start 스윕: 채널 카드 보존(legacy만 종료) → 카드 0장 경로 없음",
              P.keepIndex(hasChannelMarker: [false, true]) == 1)
        // 이어진 migration 직렬 구간: 채널 카드가 이미 살아 있으므로 adopt — 중복 request 금지.
        check("이어진 migration: 채널 카드 존재 → adopt(중복 생성 금지)",
              P.migrateMode(hasActiveSameGameChannelCard: true) == .adoptExistingChannelCard)
        // start()가 legacy를 먼저 정리한 경우 migration 직렬 구간은 abort — 이중 처리 없음.
        check("start가 먼저 정리한 legacy → migration recheck abort(이중 처리 없음)",
              P.recheck(isForegroundActive: true, legacyStillActive: false) == .abortLegacyGone)

        print("")
        print("결과: PASS \(passed) / FAIL \(failed)")
        exit(failed == 0 ? 0 : 1)
    }
}
