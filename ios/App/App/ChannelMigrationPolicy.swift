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

    // MARK: - fetch 이전 게이트 (activity 단위)

    /// 마이그레이션 시도 전 판정. 순서 고정(스모크가 고정) —
    /// OS → foreground → marker → live → 성공이력 → in-flight.
    enum Preflight: Equatable {
        case proceed
        case skipOsUnsupported     // iOS 18 미만 — .channel 재생성 불가
        case skipNotForeground     // 삼순 R2 blocker③ — silent wake/백그라운드에선 local request 금지
        case skipAlreadyChannel    // attributes.channelId marker 보유 = 이미 채널 카드
        case skipNotLive           // scheduled/final/종료된 activity — 라이브 경기만 대상
        case skipAlreadyMigrated   // 이 프로세스에서 같은 경기 마이그레이션 성공 완료
        case skipInFlight          // 같은 경기 마이그레이션 진행 중(중복 방지)
    }

    /// - Parameters:
    ///   - isForegroundActive: `UIApplication.applicationState == .active`. local
    ///     `Activity.request()`는 foreground 시작 계약 — silent wake
    ///     (`didReceiveRemoteNotification`) 컨텍스트에선 request 0건을 보장한다(삼순 R2 blocker③).
    ///   - isLive: contentState.status == .live && activityState == .active (실행측이 합성).
    ///   - alreadyMigrated: *성공*한 경기만 기록 — 실패(채널 없음/GET 실패/request 실패)는
    ///     기록하지 않아 다음 포그라운드 재시도가 허용된다(오늘처럼 채널이 늦게 생기는 케이스).
    static func preflight(osAtLeast18: Bool, isForegroundActive: Bool, hasChannelMarker: Bool,
                          isLive: Bool, alreadyMigrated: Bool, inFlight: Bool) -> Preflight {
        if !osAtLeast18 { return .skipOsUnsupported }
        if !isForegroundActive { return .skipNotForeground }
        if hasChannelMarker { return .skipAlreadyChannel }
        if !isLive { return .skipNotLive }
        if alreadyMigrated { return .skipAlreadyMigrated }
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

    // MARK: - 실행 방식 — 삼순 R2 blocker② (중복 채널 카드 방지)

    /// 같은 경기 active 채널 카드가 *이미 있으면* 신규 request 없이 legacy만 정리한다 —
    /// crash/suspend로 남은 기존 중복이 채널 카드를 하나 더 만드는 퇴행 차단.
    enum MigrateMode: Equatable {
        case adoptExistingChannelCard   // request 0건 — legacy end + 기존 채널 카드 재-ack(멱등)
        case requestNewChannelCard      // 채널 카드 없음 — fetch 후 request, 성공 시에만 legacy end
    }

    static func migrateMode(hasActiveSameGameChannelCard: Bool) -> MigrateMode {
        hasActiveSameGameChannelCard ? .adoptExistingChannelCard : .requestNewChannelCard
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

    // MARK: - GET /api/live-activity/channel 결과 판정

    /// ChannelAckPolicy.ChannelFetch 재사용 — active(자기 env 채널) / definitive nil / retryable.
    enum FetchDecision: Equatable {
        case migrate(String)       // active 채널 확보 — 채널 카드 재생성 진행
        case retryNextForeground   // 채널 미존재(늦게 생길 수 있음)·GET 일시 실패 — 레거시 유지 no-op
    }

    /// 채널 부재(definitive nil)도 폐기가 아니라 재시도 유보 — 채널은 경기 중 늦게라도
    /// 생성될 수 있으므로(7/23 파서 장애: 19:07 생성) 다음 포그라운드에서 다시 본다.
    static func onFetch(_ fetch: ChannelAckPolicy.ChannelFetch) -> FetchDecision {
        switch fetch {
        case .active(let id?): return .migrate(id)
        case .active(nil), .retryableFailure: return .retryNextForeground
        }
    }
}
