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
              P.preflight(osAtLeast18: true, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .proceed)
        check("iOS 18 미만 = skip(OS)",
              P.preflight(osAtLeast18: false, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .skipOsUnsupported)
        check("marker 보유(이미 채널 카드) = skip",
              P.preflight(osAtLeast18: true, hasChannelMarker: true, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .skipAlreadyChannel)
        check("비라이브(scheduled/final/ended) = skip",
              P.preflight(osAtLeast18: true, hasChannelMarker: false, isLive: false,
                          alreadyMigrated: false, inFlight: false) == .skipNotLive)
        check("같은 경기 성공 완료 = skip(경기당 1회)",
              P.preflight(osAtLeast18: true, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: true, inFlight: false) == .skipAlreadyMigrated)
        check("같은 경기 in-flight = skip(동시 중복 방지)",
              P.preflight(osAtLeast18: true, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: false, inFlight: true) == .skipInFlight)
        check("marker 게이트가 live 게이트보다 우선(채널 카드는 상태 무관 no-op)",
              P.preflight(osAtLeast18: true, hasChannelMarker: true, isLive: false,
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
              P.preflight(osAtLeast18: true, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .proceed)
        check("18:00 fetch(채널 없음) = retry — 레거시 유지·완료 마킹 없음",
              P.onFetch(ChannelAckPolicy.classifyFetch(status: 200, parsed: true, channelId: nil))
                  == .retryNextForeground)
        // 19:30 앱 오픈: alreadyMigrated=false 그대로(실패는 마킹 안 함) → 재시도 허용
        check("19:30 preflight = proceed(재시도 허용)",
              P.preflight(osAtLeast18: true, hasChannelMarker: false, isLive: true,
                          alreadyMigrated: false, inFlight: false) == .proceed)
        check("19:30 fetch(채널 생성됨) = migrate",
              P.onFetch(ChannelAckPolicy.classifyFetch(status: 200, parsed: true, channelId: "chA"))
                  == .migrate("chA"))
        // 재생성 성공 → 새 activity는 marker 보유 → 이후 rescan은 항상 no-op
        check("마이그레이션 후 새 카드(marker 보유) rescan = skip",
              P.preflight(osAtLeast18: true, hasChannelMarker: true, isLive: true,
                          alreadyMigrated: true, inFlight: false) == .skipAlreadyChannel)

        print("")
        print("결과: PASS \(passed) / FAIL \(failed)")
        exit(failed == 0 ? 0 : 1)
    }
}
