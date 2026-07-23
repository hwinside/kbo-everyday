//
//  ChannelMigrationPolicy.swift
//  KBO 크보팬 — 메인 앱 타깃
//
//  레거시(per-토큰) Live Activity → broadcast 채널 카드 포그라운드 마이그레이션 판정
//  (순수 로직, Foundation 전용). LiveActivityController.rescanActiveActivities가 소비하고,
//  scripts/qa/la-channel-migration-policy-smoke.swift 가 회귀를 고정한다.
//
//  배경(2026-07-23 하린아빠 P0): 파서 장애로 채널이 경기 시작 *후*에 생성되면 그날 카드는
//  전부 레거시 방식으로 태어난다. iOS는 기존 activity의 push 방식 변경이 불가하고 per-토큰
//  갱신은 예산 스로틀 → 카드가 이닝 단위로 뒤처지는데, 기존 rescan은 update 토큰 재등록만
//  해서 앱을 열어도 복구가 안 됐다. 본 정책이 "포그라운드 시 레거시 감지 → 채널 카드로
//  재생성" 여부를 결정한다.
//
//  안전 원칙: 실행측(LiveActivityController)은 *재생성 성공 후에만* 레거시를 end한다 —
//  어떤 실패 경로에서도 카드만 죽고 끝나지 않는다(레거시 유지 = no-op).
//

import Foundation

enum ChannelMigrationPolicy {

    // MARK: - reconcile 이전 게이트 (game 단위 — 삼순 R4)

    /// game 단위 reconcile 시도 전 판정. 순서 고정(스모크가 고정) —
    /// OS → foreground → 라이브 카드 존재 → in-flight.
    /// R4(삼순 blocker): 영구 성공 캐시(alreadyMigrated) 제거 — foreground마다 game 단위로
    /// 재검사한다(B→C 연속 채널 교체도 다음 foreground가 잡음). 게이트는 순수 함수라
    /// 그대로 유지되고, "이미 수렴했으니 skip"이라는 프로세스-영구 캐시만 제거됐다.
    enum Preflight: Equatable {
        case proceed
        case skipOsUnsupported     // iOS 18 미만 — .channel 재생성 불가
        case skipNotForeground     // 삼순 R2 blocker③ — silent wake/백그라운드에선 local request 금지
        case skipNoLiveCard        // 이 game에 라이브 active 카드 없음 — reconcile 대상 아님
        case skipInFlight          // 같은 경기 reconcile 진행 중(중복 방지)
    }

    /// - Parameters:
    ///   - isForegroundActive: `UIApplication.applicationState == .active`. local
    ///     `Activity.request()`는 foreground 시작 계약 — silent wake
    ///     (`didReceiveRemoteNotification`) 컨텍스트에선 request 0건을 보장한다(삼순 R2 blocker③).
    ///   - gameHasLiveCard: 이 game에 status==.live && activityState==.active 카드가 ≥1장
    ///     (실행측이 합성). scheduled/final만 있는 game은 대상 아님.
    ///   - inFlight: 같은 game reconcile Task가 진행 중(중복 방지). 영구 캐시가 아니라
    ///     *진행 중에만* true — 완료되면 해제되어 다음 foreground가 다시 reconcile한다.
    static func preflight(osAtLeast18: Bool, isForegroundActive: Bool,
                          gameHasLiveCard: Bool, inFlight: Bool) -> Preflight {
        if !osAtLeast18 { return .skipOsUnsupported }
        if !isForegroundActive { return .skipNotForeground }
        if !gameHasLiveCard { return .skipNoLiveCard }
        if inFlight { return .skipInFlight }
        return .proceed
    }

    // MARK: - 직렬 구간(경기 락 내) 재검증 — 삼순 R2 blocker①③

    /// migration Task가 경기 직렬 큐를 획득한 *직후* 재검증. 락 대기 중 start()/end()가
    /// 카드를 정리했거나 앱이 백그라운드로 전환됐을 수 있다 — request 직전 최종 게이트.
    enum SerializedRecheck: Equatable {
        case proceed
        case abortBackground   // 앱이 background 전환 — request 금지(0건), 다음 foreground 재시도
        case abortLegacyGone   // 레거시 카드가 이미 정리됨(start 스윕 등) — 할 일 없음
    }

    /// 순서 고정 — background(request-0 보장)가 legacy 존재 여부보다 우선.
    static func recheck(isForegroundActive: Bool, legacyStillActive: Bool) -> SerializedRecheck {
        if !isForegroundActive { return .abortBackground }
        if !legacyStillActive { return .abortLegacyGone }
        return .proceed
    }

    // MARK: - game 단위 reconcile — 삼순 R4 blocker (영구 캐시 제거 · 비현재 카드 전부 정리)

    /// foreground마다 game 단위로 호출. 영구 캐시 없음 — 매 foreground 재검사.
    /// 목표 수렴: foreground 1회 후 해당 game = 현재 active 채널 카드 1장 / 비현재 0장.
    ///
    /// R4 blocker① (B→C 연속 교체): 같은 game의 모든 active 카드를 한 번에 보고 현재 채널
    /// 1장으로 수렴시킨다 — 이전 activity 단위 처리+영구 캐시는 migrate된 game을 skip해 다음
    /// 교체를 놓쳤다. marker가 매번 현재 채널과 비교되므로 B→C도 다음 foreground가 잡는다.
    /// R4 blocker② ([현재 B, 구채널 A/레거시] 순서): 현재 채널 카드 하나만 남기고 비현재
    /// (구채널·레거시) 카드는 카드 순서 무관 전부 정리 — 이전구현은 B만 ACK하고 A 잔존.
    /// 안전 원칙(카드 0장 불가): 현재 채널 카드를 *확보(adopt/재생성 성공)한 뒤에만* 비현재 end.
    enum ReconcilePlan: Equatable {
        case retryNextForeground                         // active 채널 부재/GET 실패 — 전 카드 유지 no-op
        case adoptCurrent(keep: Int, end: [Int])         // 현재 채널 카드 존재 — 재-ack 후 비현재 end
        case requestCurrent(channelId: String, end: [Int]) // 현재 채널 카드 없음 — request 성공 후 전 카드 end
    }

    /// - Parameters:
    ///   - cardChannelIds: 같은 game의 active 카드 marker 배열(enumerate 순서, 레거시는 nil).
    ///   - fetch: 현재 active 채널 조회 결과(GET /api/live-activity/channel).
    ///
    /// current-first: fetch가 active 채널을 줄 때만 카드를 건든다(부재/실패는 전원 유지).
    /// 비현재 end는 실행측이 현재 카드 확보 후에만 수행(계획은 index만 반환). 중복 현재-채널
    /// 카드(동일 marker 여러 장)는 firstIndex만 keep, 나머지는 end에 넣어 1장으로 수렴한다.
    static func reconcile(cardChannelIds: [String?],
                          fetch: ChannelAckPolicy.ChannelFetch) -> ReconcilePlan {
        switch fetch {
        case .active(nil), .retryableFailure:
            return .retryNextForeground
        case .active(let current?):
            if let keep = cardChannelIds.firstIndex(where: { $0 == current }) {
                let end = cardChannelIds.indices.filter { $0 != keep }
                return .adoptCurrent(keep: keep, end: Array(end))
            }
            return .requestCurrent(channelId: current, end: Array(cardChannelIds.indices))
        }
    }

    // MARK: - start() 정리 스윕 보존 선택 — 삼순 R2 blocker① (채널 카드 최우선 보존)

    /// 같은 경기 카드들(channel marker 보유 여부 배열, enumerate 순서) 중 보존할 인덱스.
    /// 채널 카드가 있으면 *첫 채널 카드*, 없으면 첫 카드 — 기존 "임의 first-card 보존"이
    /// migration이 방금 만든 채널 카드를 종료시키던 경합 차단. 카드가 하나라도 있으면
    /// 반드시 하나를 보존한다(비어 있지 않으면 nil 불가 = 카드 0장 경로 없음).
    static func keepIndex(hasChannelMarker: [Bool]) -> Int? {
        if let channelIdx = hasChannelMarker.firstIndex(of: true) { return channelIdx }
        return hasChannelMarker.isEmpty ? nil : 0
    }

    // MARK: - start() 신규 시작 판정 — 삼순 R2 blocker④ (레거시 fallback 차단)

    /// build16+/iOS18+ 신규 시작은 *채널 카드만*. 채널 미준비(definitive 부재)·GET 일시 실패
    /// = 시작 유보(다음 기회 재시도) — 레거시 `.token` fallback으로 시작하는 동작 자체를
    /// 금지한다(7/23 사고 입구: fallback으로 태어난 레거시 카드가 예산 스로틀에 갇힘).
    /// iOS 17 이하/build 15 이하는 이 판정에 도달하지 않는다(isEnabled 18 게이트·구빌드 바이너리).
    enum StartDecision: Equatable {
        case startChannelCard(String)   // 자기 env active 채널 확보 — 채널 카드로만 시작
        case deferStart                 // 채널 미준비/조회 실패 — 시작 유보(레거시 fallback 금지)
    }

    static func startDecision(_ fetch: ChannelAckPolicy.ChannelFetch) -> StartDecision {
        switch fetch {
        case .active(let id?): return .startChannelCard(id)
        case .active(nil), .retryableFailure: return .deferStart
        }
    }

}

// MARK: - 실행 orchestrator — 삼순 R5 blocker (조립 코드 주입 가능 추출 + fetch 후 재게이트)

/// `LiveActivityController.reconcileGameSerialized`의 request/end 조립 순서를 그대로 추출한
/// 실행 orchestrator(Foundation 전용). 게이트·순서·실패 처리 등 흐름 제어는 전부 여기 한 곳에
/// 있고, Controller는 ActivityKit/UIKit effect(포그라운드 조회·fetch·request·end·ack)만
/// closure로 주입한다 — 스모크가 mock effect로 *동일한 조립 코드*를 실행해 배선 회귀를
/// 고정한다(삼순 R5 blocker②: policy 순수함수만 검증하던 회귀의 공백 해소).
enum ChannelMigrationOrchestrator {

    /// reconcile 1회 실행 결과 — 실행측 로깅·스모크 검증용 관측치.
    enum Outcome: Equatable {
        case abortBackgroundPreFetch    // fetch 이전 background — effect 0, 다음 foreground 재시도
        case abortLegacyGone            // 카드 이미 정리(start 스윕 등) — 할 일 없음
        case abortBackgroundPostFetch   // R5 blocker① — fetch await 중 background 전환: request/end 0, 전 카드 유지
        case retryNextForeground        // active 채널 부재/GET 일시 실패 — 전 카드 유지
        case adopted(keep: Int, ended: [Int])          // 현재 카드 재-ack 후 비현재 end
        case recreated(channelId: String, ended: [Int]) // request 성공 후 스냅샷 전 카드 end
        case requestFailedKeepAll       // request 실패 — end 0, 전 카드 유지
    }

    /// - Parameters:
    ///   - cardChannelIds: 직렬 구간 진입 시점의 game active 카드 marker 스냅샷(레거시 nil).
    ///   - isForegroundActive: MainActor에서 `applicationState == .active` 조회 — *호출 시점마다
    ///     재평가*된다(fetch 전 1회 + fetch 후 request/end 직전 1회, R5 blocker①).
    ///   - fetchActiveChannel: GET /api/live-activity/channel 1회 조회.
    ///   - adoptCurrent: 현재 채널 카드(keep idx) 재-ack + currentActivity 승계.
    ///   - requestCurrent: 현재 채널로 `Activity.request` — 성공 여부 반환(실패 = end 금지).
    ///   - endCard: 스냅샷 idx 카드 end(.immediate).
    static func reconcile(
        cardChannelIds: [String?],
        isForegroundActive: () async -> Bool,
        fetchActiveChannel: () async -> ChannelAckPolicy.ChannelFetch,
        adoptCurrent: (Int) async -> Void,
        requestCurrent: (String) async -> Bool,
        endCard: (Int) async -> Void
    ) async -> Outcome {
        // 직렬 구간 재검증 — 락 대기 중 background 전환/카드 선정리(R2 blocker③).
        switch ChannelMigrationPolicy.recheck(
            isForegroundActive: await isForegroundActive(),
            legacyStillActive: !cardChannelIds.isEmpty
        ) {
        case .abortBackground: return .abortBackgroundPreFetch
        case .abortLegacyGone: return .abortLegacyGone
        case .proceed: break
        }
        let fetch = await fetchActiveChannel()
        // R5 blocker① — 채널 fetch를 await하는 동안 앱이 background로 전환됐을 수 있다.
        // request/end 바로 전에 foreground를 재확인하고, background면 effect 0으로 중단
        // (전 카드 유지 = no-op). 다음 foreground(didBecomeActive)가 reconcile을 재시도한다.
        guard await isForegroundActive() else { return .abortBackgroundPostFetch }
        switch ChannelMigrationPolicy.reconcile(cardChannelIds: cardChannelIds, fetch: fetch) {
        case .retryNextForeground:
            return .retryNextForeground
        case .adoptCurrent(let keep, let end):
            // 현재 카드 확보(재-ack) 확인 후에만 비현재 end — 카드 0장 불가.
            await adoptCurrent(keep)
            for idx in end { await endCard(idx) }
            return .adopted(keep: keep, ended: end)
        case .requestCurrent(let channelId, let end):
            // current-first: request 성공 후에만 스냅샷 전 카드 end. 실패 시 전 카드 유지.
            guard await requestCurrent(channelId) else { return .requestFailedKeepAll }
            for idx in end { await endCard(idx) }
            return .recreated(channelId: channelId, ended: end)
        }
    }

}
