//
//  la-channel-migration-policy-smoke.swift
//  레거시 → broadcast 채널 마이그레이션 정책 회귀 스모크 —
//  ios/App/App/ChannelMigrationPolicy.swift 를 고정한다.
//
//  배경(2026-07-23 파서 장애): 채널이 경기 시작 후 생성되면 그날 카드는 전부 레거시로
//  태어나고, 앱을 열어도 복구가 안 됐다(rescan이 토큰 재등록만 함). 본 정책 회귀 기준:
//   ① 게이트 — iOS<18 / 비라이브 / 현재-채널 수렴 완료 / in-flight = no-op
//   ② 채널 부재·GET 일시 실패 = 폐기 아닌 재시도 유보(채널이 늦게 생기는 케이스 커버)
//   ③ active 채널 확보 시에만 migrate — 재생성 실패 안전은 실행측 순서(request 성공 후
//     end)가 보장하며, 실패는 마이그레이션 완료로 마킹되지 않아 다음 포그라운드 재시도
//  라운드2(삼순 R2 blocker 반영):
//   ④ background request 0 — foreground-active 아니면 preflight/recheck 모두 차단
//   ⑤ 경합 시 채널 카드 생존 — start() 스윕은 채널 카드 최우선 보존, 카드 있으면 keep ≠ nil(0장 불가)
//   ⑥ 중복 채널 방지 — 같은 경기 active *현재* 채널 카드 존재 시 request 없이 비현재만 정리
//   ⑦ fallback 차단 — 신규 start는 채널 카드만: 채널 미준비/조회 실패 = 시작 유보(레거시 금지)
//  라운드3(삼순 R3 blocker② 반영):
//   ⑨ 구채널 marker A → 현재 active B 복구 — marker 보유 카드도 preflight 통과, resolve가
//     marker×active 대조로 alreadyCurrent / migrate(B) / retry 판정(재생성 성공 후에만 end)
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

        // ── ① preflight 게이트 표 (R3: marker 게이트 제거 — 구채널 복구 위해 marker 카드도 통과) ──
        print("[① preflight — 포그·라이브·비중복일 때 진행(marker 무관)]")
        check("레거시 + 라이브 + 첫 시도 = proceed",
              P.preflight(osAtLeast18: true, isForegroundActive: true, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .proceed)
        check("iOS 18 미만 = skip(OS)",
              P.preflight(osAtLeast18: false, isForegroundActive: true, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .skipOsUnsupported)
        check("R3: marker 보유 카드도 preflight 통과 — 구채널 A→현재 B 복구 위해(resolve가 이후 판정)",
              P.preflight(osAtLeast18: true, isForegroundActive: true, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .proceed)
        check("비라이브(scheduled/final/ended) = skip",
              P.preflight(osAtLeast18: true, isForegroundActive: true, isLive: false,
                          alreadyMigrated: false, inFlight: false) == .skipNotLive)
        check("같은 경기 현재-채널 수렴 완료 = skip(경기당 1회)",
              P.preflight(osAtLeast18: true, isForegroundActive: true, isLive: true,
                          alreadyMigrated: true, inFlight: false) == .skipAlreadyMigrated)
        check("같은 경기 in-flight = skip(동시 중복 방지)",
              P.preflight(osAtLeast18: true, isForegroundActive: true, isLive: true,
                          alreadyMigrated: false, inFlight: true) == .skipInFlight)

        // ── ② resolve 판정 — 카드 marker × 현재 active 채널 대조(R3 삼순 blocker②) ──
        print("[② resolve — 구채널 A→현재 B 복구·현재 수렴·유보]")
        check("레거시(marker nil) + active B → migrate(B)",
              P.resolve(cardMarker: nil, fetch: .active("chB")) == .migrate("chB"))
        check("구채널 marker A + active B → migrate(B) [핵심: A≠B 복구]",
              P.resolve(cardMarker: "chA", fetch: .active("chB")) == .migrate("chB"))
        check("marker B + active B → alreadyCurrent(request/adopt 0, 수렴 마킹)",
              P.resolve(cardMarker: "chB", fetch: .active("chB")) == .alreadyCurrent)
        check("레거시 + active 채널 부재 → retry(채널이 늦게 생길 수 있음 — 7/23)",
              P.resolve(cardMarker: nil, fetch: .active(nil)) == .retryNextForeground)
        check("구채널 marker A + active 부재 → retry(A 카드 유지 — 재생성 불가로 end 금지, 카드 손실 방지)",
              P.resolve(cardMarker: "chA", fetch: .active(nil)) == .retryNextForeground)
        check("GET network/5xx/파싱 실패 → retry(확정 아님, 카드 유지)",
              P.resolve(cardMarker: "chA", fetch: .retryableFailure) == .retryNextForeground)

        // ── ③ 시나리오: 7/23 파서 장애 재현 — 채널 늦은 생성 후 앱 오픈 시 복구 ──
        print("[③ 시나리오 — 18:00 오픈(채널 없음) no-op → 19:30 오픈(채널 있음) migrate]")
        check("18:00 preflight = proceed(시도는 함)",
              P.preflight(osAtLeast18: true, isForegroundActive: true, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .proceed)
        check("18:00 resolve(레거시 + 채널 없음) = retry — 카드 유지·완료 마킹 없음",
              P.resolve(cardMarker: nil, fetch: ChannelAckPolicy.classifyFetch(status: 200, parsed: true, channelId: nil))
                  == .retryNextForeground)
        check("19:30 preflight = proceed(재시도 허용)",
              P.preflight(osAtLeast18: true, isForegroundActive: true, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .proceed)
        check("19:30 resolve(레거시 + 채널 생성됨) = migrate",
              P.resolve(cardMarker: nil, fetch: ChannelAckPolicy.classifyFetch(status: 200, parsed: true, channelId: "chA"))
                  == .migrate("chA"))
        // 재생성 성공 → 새 activity는 현재 marker(chA) 보유 → 이후 rescan은 alreadyCurrent(no-op)
        check("마이그레이션 후 새 카드(marker chA == active) rescan = alreadyCurrent",
              P.resolve(cardMarker: "chA", fetch: .active("chA")) == .alreadyCurrent)

        // ── ④ R2 blocker③ — background에서 local Activity.request() 0건 ──
        print("[④ foreground 게이트 — silent wake/background = request 0건]")
        check("background(silent wake) preflight = skipNotForeground — 다른 조건 충족해도 차단",
              P.preflight(osAtLeast18: true, isForegroundActive: false, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .skipNotForeground)
        check("foreground 게이트가 live 게이트보다 우선(순서 고정)",
              P.preflight(osAtLeast18: true, isForegroundActive: false, isLive: false,
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

        // ── ⑥ R2 blocker② + R3 — 중복 채널 방지(현재 채널 기준) ──
        print("[⑥ 중복 채널 방지 — 같은 경기 *현재* 채널 카드 있으면 request 없이 비현재만 정리]")
        check("현재 active 채널 카드 존재 → adopt(신규 request 0건)",
              P.migrateMode(hasActiveCurrentChannelCard: true) == .adoptExistingChannelCard)
        check("현재 채널 카드 없음 → requestNewChannelCard(request)",
              P.migrateMode(hasActiveCurrentChannelCard: false) == .requestNewChannelCard)

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
        check("start 스윕: 채널 카드 보존(legacy만 종료) → 카드 0장 경로 없음",
              P.keepIndex(hasChannelMarker: [false, true]) == 1)
        check("이어진 migration: 현재 채널 카드 존재 → adopt(중복 생성 금지)",
              P.migrateMode(hasActiveCurrentChannelCard: true) == .adoptExistingChannelCard)
        check("start가 먼저 정리한 legacy → migration recheck abort(이중 처리 없음)",
              P.recheck(isForegroundActive: true, legacyStillActive: false) == .abortLegacyGone)

        // ── ⑨ R3 blocker② 시나리오 — 구채널 A 카드 → 현재 B 채널 복구 ──
        print("[⑨ 시나리오 — 구채널 marker A 카드, 현재 active B로 재생성 후 A 종료]")
        // 채널이 재발급된 경기: 카드는 A marker 보유하지만 현재 active 채널은 B.
        check("구채널 A 카드 preflight = proceed(marker 있어도 통과)",
              P.preflight(osAtLeast18: true, isForegroundActive: true, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .proceed)
        check("resolve(marker A, active B) = migrate(B) — 현재 채널로 재생성",
              P.resolve(cardMarker: "chA", fetch: .active("chB")) == .migrate("chB"))
        // 현재 B 카드가 아직 없으므로 request 신규(성공 후에만 A end).
        check("현재(B) 채널 카드 없음 → requestNewChannelCard(재생성, 성공 후 A end)",
              P.migrateMode(hasActiveCurrentChannelCard: false) == .requestNewChannelCard)
        // 재생성 성공 후 새 카드는 marker B == active B → 이후 rescan alreadyCurrent(수렴).
        check("재생성 후 marker B == active B → alreadyCurrent(수렴, 추가 request 0)",
              P.resolve(cardMarker: "chB", fetch: .active("chB")) == .alreadyCurrent)
        // 만약 이미 B 카드가 병렬로 생성돼 있으면 adopt — A만 정리, 중복 B request 금지.
        check("현재 B 카드 이미 존재 → adopt(A만 정리, 중복 B 생성 금지)",
              P.migrateMode(hasActiveCurrentChannelCard: true) == .adoptExistingChannelCard)

        print("")
        print("결과: PASS \(passed) / FAIL \(failed)")
        exit(failed == 0 ? 0 : 1)
    }
}
