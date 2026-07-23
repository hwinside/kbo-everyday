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

    /// 마이그레이션 시도 전 판정. 순서 고정(스모크가 고정) — OS → marker → live → 성공이력 → in-flight.
    enum Preflight: Equatable {
        case proceed
        case skipOsUnsupported     // iOS 18 미만 — .channel 재생성 불가
        case skipAlreadyChannel    // attributes.channelId marker 보유 = 이미 채널 카드
        case skipNotLive           // scheduled/final/종료된 activity — 라이브 경기만 대상
        case skipAlreadyMigrated   // 이 프로세스에서 같은 경기 마이그레이션 성공 완료
        case skipInFlight          // 같은 경기 마이그레이션 진행 중(중복 방지)
    }

    /// - Parameters:
    ///   - isLive: contentState.status == .live && activityState == .active (실행측이 합성).
    ///   - alreadyMigrated: *성공*한 경기만 기록 — 실패(채널 없음/GET 실패/request 실패)는
    ///     기록하지 않아 다음 포그라운드 재시도가 허용된다(오늘처럼 채널이 늦게 생기는 케이스).
    static func preflight(osAtLeast18: Bool, hasChannelMarker: Bool, isLive: Bool,
                          alreadyMigrated: Bool, inFlight: Bool) -> Preflight {
        if !osAtLeast18 { return .skipOsUnsupported }
        if hasChannelMarker { return .skipAlreadyChannel }
        if !isLive { return .skipNotLive }
        if alreadyMigrated { return .skipAlreadyMigrated }
        if inFlight { return .skipInFlight }
        return .proceed
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
