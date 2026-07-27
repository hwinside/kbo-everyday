//
//  KBOHomeWidget.swift
//  KBO 크보팬 — 홈 화면 위젯 (WidgetKit StaticConfiguration)
//
//  잠금화면 Live Activity 카드(KBOLockScreenCard, #248 MY TEAM 디자인)와 동일한
//  디자인을 홈 화면 위젯으로 제공한다. 안드로이드 GameScoreWidget(SharedPreferences)
//  의 iOS판 — 앱이 App Group(group.fan.keubo.app)에 현재 경기 스냅샷을 기록하면
//  위젯이 이를 읽어 표시한다.
//
//  ⚠️ iOS 홈 위젯은 안드로이드와 달리 백그라운드 실시간 푸시 갱신이 불가하다(플랫폼 제약).
//  앱이 활성/경기룸 진입 시 스냅샷 기록 + WidgetCenter.reloadAllTimelines()로 갱신되며,
//  그 외엔 시스템 타임라인 주기로 새로고침된다. 백그라운드 실시간 갱신은 잠금화면
//  Live Activity(W3a APNs)가 담당하고, 홈 위젯은 "최근 스코어 스냅샷" 성격이다.
//
//  카드 디자인 자체(레이아웃·폰트·다이아몬드·팀 컬러)는 KBOLiveActivityWidget.swift의
//  KBOLockScreenCard / TeamBadge / DiamondView / TeamLogo 및 teamColor·teamShortName·
//  montserrat·notoKR 헬퍼를 그대로 재사용한다 (단일 소스).
//

import SwiftUI
import WidgetKit

// MARK: - App Group 스냅샷 (앱의 LiveActivityController.writeWidgetSnapshot가 기록)

private let kAppGroup = "group.fan.keubo.app"
private let kSnapshotKey = "kbo_widget_snapshot"

/// B안 — 홈위젯 live 스냅샷 stale 판정 임계(초). iOS 홈위젯은 서버 푸시로 직접 갱신되지 않아
/// 앱을 닫으면 마지막 LIVE 스냅샷에 얼어붙는다. A안(무음 wake) 유실 시 백스톱으로, live 스냅샷이
/// 기록 후 이 시간을 넘도록 갱신 안 되면 LIVE를 떼고 '업데이트 필요'로 표시한다. 우천 중단 등
/// 장시간 진행 케이스를 감안해 4h가 아닌 5h(하린아빠).
private let kStaleLiveSeconds: TimeInterval = 5 * 60 * 60

struct WidgetGameSnapshot: Codable {
    var hasGame: Bool
    var gameId: String
    var awayTeamCode: String
    var homeTeamCode: String
    var myTeamCode: String
    var awayScore: Int
    var homeScore: Int
    var inning: Int
    var isTopInning: Bool
    var outs: Int
    var onFirst: Bool
    var onSecond: Bool
    var onThird: Bool
    var pitcherName: String
    var batterName: String
    var stadium: String
    var isFinal: Bool
    /// "live" | "final" | "scheduled" | "cancelled". 구버전 스냅샷엔 없을 수 있어 옵셔널(기본 nil).
    /// 없으면 isFinal로 live/final을 추론(하위호환). "scheduled"/"cancelled"면 다음 경기 카드.
    var status: String? = nil
    /// 문자중계 최근 플레이 한 줄(1.0.7, 옵셔널) — 잠금 카드와 동일 소스/렌더. 구버전 스냅샷 nil 안전.
    var lastPlay: String? = nil
    /// 예정/취소 경기 표시용 시각 문구(예: "18:30"). live/final이면 빈 문자열.
    var startText: String? = nil
    /// 예정 경기 날짜 라벨(예: "6월 7일 (토)"). 구장 위에 표시. scheduled에서만.
    var dateText: String? = nil
    /// 예고선발 투수명(원정/홈). scheduled에서만. 미확정이면 nil/빈 문자열 → "선발 미정".
    var awayStarter: String? = nil
    var homeStarter: String? = nil
    /// 다음 예정 경기 — 결과(final)/라이브 스냅샷일 때만 채워짐. 홈 팀카드 06시 규칙대로
    /// 위젯이 앱 실행 없이 '경기일 다음날 06:00'에 이 경기로 자동 전환(getTimeline).
    var next: NextGameSnapshot? = nil
    /// 스냅샷 기록 시각(epoch초, 앱 LiveActivityController가 매 기록 시 찍음). live 스냅샷이 이
    /// 시각+5h를 넘도록 갱신 안 되면 stale로 본다(B안). 구버전 스냅샷엔 없을 수 있어 옵셔널.
    var savedAt: Double? = nil
    /// getTimeline이 stale 판정 시 세팅하는 렌더 전용 플래그. 스냅샷 JSON엔 저장 안 됨 →
    /// 반드시 optional로 둔다. 비-optional+기본값은 Swift 합성 Codable이 기본값을 디코딩에 쓰지
    /// 않아, 키 부재 시 keyNotFound throw → 위젯이 스냅샷을 통째로 못 읽는다(삼순 리뷰 #593,
    /// 실측 확인). 렌더는 `== true`로 판정.
    var isStale: Bool? = nil

    /// 렌더 분기용 정규화 상태.
    var resolvedStatus: String {
        if let s = status, !s.isEmpty { return s }
        return isFinal ? "final" : "live"
    }
}

/// 다음 예정 경기(라이트). WidgetGameSnapshot를 재귀 저장하면 값 타입 무한크기라 불가 →
/// 예정 카드 렌더에 필요한 필드만 담고, asSnapshot()으로 scheduled 스냅샷으로 승격한다.
struct NextGameSnapshot: Codable {
    var gameId: String
    var awayTeamCode: String
    var homeTeamCode: String
    var myTeamCode: String
    var stadium: String
    var startText: String
    var dateText: String
    var awayStarter: String? = nil
    var homeStarter: String? = nil

    func asSnapshot() -> WidgetGameSnapshot {
        WidgetGameSnapshot(
            hasGame: true, gameId: gameId,
            awayTeamCode: awayTeamCode, homeTeamCode: homeTeamCode, myTeamCode: myTeamCode,
            awayScore: 0, homeScore: 0, inning: 1, isTopInning: true, outs: 0,
            onFirst: false, onSecond: false, onThird: false,
            pitcherName: "", batterName: "", stadium: stadium, isFinal: false,
            status: "scheduled", startText: startText, dateText: dateText,
            awayStarter: awayStarter, homeStarter: homeStarter
        )
    }
}

private func loadSnapshot() -> WidgetGameSnapshot? {
    guard let ud = UserDefaults(suiteName: kAppGroup),
          let data = ud.data(forKey: kSnapshotKey),
          let snap = try? JSONDecoder().decode(WidgetGameSnapshot.self, from: data),
          snap.hasGame else {
        return nil
    }
    return snap
}

// 미리보기/플레이스홀더용 더미 경기 — 실팀/실선수 노출 금지(익명화, 안드 피커 미리보기와
// 동일 정책 2026-07-08). XA/XH는 더미 전용 코드(수달스/돌고래스, teamShortName 참조).
private let sampleSnapshot = WidgetGameSnapshot(
    hasGame: true, gameId: "SAMPLE", awayTeamCode: "XA", homeTeamCode: "XH",
    myTeamCode: "XH", awayScore: 3, homeScore: 5, inning: 7, isTopInning: false,
    outs: 1, onFirst: true, onSecond: false, onThird: true,
    pitcherName: "수달", batterName: "돌고래", stadium: "크보파크", isFinal: false
)

// MARK: - Timeline

struct GameWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetGameSnapshot?
}

struct GameWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> GameWidgetEntry {
        GameWidgetEntry(date: Date(), snapshot: sampleSnapshot)
    }

    func getSnapshot(in context: Context, completion: @escaping (GameWidgetEntry) -> Void) {
        let snap = context.isPreview ? sampleSnapshot : loadSnapshot()
        completion(GameWidgetEntry(date: Date(), snapshot: snap))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GameWidgetEntry>) -> Void) {
        let snap = loadSnapshot()
        let now = Date()
        var entries: [GameWidgetEntry] = []

        // B안 stale 가드 — live 스냅샷이 기록 후 kStaleLiveSeconds(5h)를 넘도록 갱신 안 되면
        // (앱 미실행 + A안 무음 wake 유실) LIVE를 떼고 stale 변형으로 전환한다. savedAt 없는
        // 구버전 스냅샷/비-live 상태는 대상 아님(staleAt = nil).
        let staleAt: Date? = {
            guard let s = snap, s.resolvedStatus == "live", let ts = s.savedAt else { return nil }
            return Date(timeIntervalSince1970: ts).addingTimeInterval(kStaleLiveSeconds)
        }()
        func staleVariant(_ s: WidgetGameSnapshot) -> WidgetGameSnapshot {
            var c = s; c.isStale = true; return c
        }
        // 현재 스냅샷을 now에 추가하되, live면 staleAt 도달 시 stale 변형으로 전환한다.
        // 이미 stale 지났으면 지금 stale, 아직이면 지금 live + staleAt에 전환 엔트리 예약
        // (rollover 이전으로 한정 — cutoff). live가 아니면 staleAt=nil이라 그냥 현재 스냅샷.
        func appendCurrent(before cutoff: Date?) {
            guard let s = snap else {
                entries.append(GameWidgetEntry(date: now, snapshot: nil))
                return
            }
            guard let staleAt else {
                entries.append(GameWidgetEntry(date: now, snapshot: s))
                return
            }
            if now >= staleAt {
                entries.append(GameWidgetEntry(date: now, snapshot: staleVariant(s)))
            } else {
                entries.append(GameWidgetEntry(date: now, snapshot: s))
                if cutoff == nil || staleAt < cutoff! {
                    entries.append(GameWidgetEntry(date: staleAt, snapshot: staleVariant(s)))
                }
            }
        }

        // 홈 팀카드 06시 규칙 이식: 스냅샷에 다음 예정 경기가 캐시돼 있으면 '경기일 다음날
        // 06:00' 시점 엔트리를 추가해 앱 실행 없이도 위젯이 '경기 예정'으로 스스로 전환한다.
        // 상태 무관(예정 포함) — 예정 경기가 백그라운드서 종료로 안 바뀌어도(LA 미발동) 그날이
        // 지나면 다음 경기로 넘어가야 하고, rollover 시각이 미래면 아래서 현재 스냅샷을 유지한다.
        // iOS 홈 위젯은 서버 푸시 갱신이 불가하므로 타임라인으로 처리.
        if let snap, let nextRaw = snap.next,
           let rollover = Self.rollover6amKST(gameId: snap.gameId) {
            let nextSnap = nextRaw.asSnapshot()
            if now >= rollover {
                // 이미 전환 시각을 지남 → 지금 바로 예정 경기 표시(앱 미실행 폴백).
                entries.append(GameWidgetEntry(date: now, snapshot: nextSnap))
            } else {
                // 전환 전 → 지금은 결과(live면 5h 후 stale), rollover 시점에 예정 경기로 자동 전환.
                appendCurrent(before: rollover)
                entries.append(GameWidgetEntry(date: rollover, snapshot: nextSnap))
            }
        } else {
            appendCurrent(before: nil)
        }

        // 앱이 reloadAllTimelines()로 즉시 갱신하지만, 백그라운드 폴백으로 15분마다 재요청.
        let refresh = now.addingTimeInterval(15 * 60)
        completion(Timeline(entries: entries, policy: .after(refresh)))
    }

    /// 결과 스냅샷을 다음 예정 경기로 넘길 시각 = 경기일(gameId 앞 8자리 YYYYMMDD) 다음날 06:00 KST.
    static func rollover6amKST(gameId: String) -> Date? {
        guard gameId.count >= 8 else { return nil }
        let p = gameId.prefix(8)
        guard let y = Int(p.prefix(4)),
              let mo = Int(p.dropFirst(4).prefix(2)),
              let d = Int(p.dropFirst(6).prefix(2)),
              let tz = TimeZone(identifier: "Asia/Seoul") else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz
        var comp = DateComponents()
        comp.year = y; comp.month = mo; comp.day = d; comp.hour = 6; comp.minute = 0
        guard let gameDay6am = cal.date(from: comp) else { return nil }
        return cal.date(byAdding: .day, value: 1, to: gameDay6am)
    }
}

// MARK: - iOS 17 containerBackground 호환

private extension View {
    @ViewBuilder
    func widgetContainerBackground<B: View>(@ViewBuilder _ bg: () -> B) -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(for: .widget) { bg() }
        } else {
            self.background(bg())
        }
    }
}

// MARK: - 위젯 뷰

@available(iOS 16.1, *)
struct KBOHomeWidgetEntryView: View {
    @Environment(\.widgetFamily) var family
    let entry: GameWidgetEntry

    var body: some View {
        // '새로고침만' 모드(iOS17+)면 콘텐츠 전체를 새로고침 인텐트 버튼으로 감싼다(앱 미실행).
        // containerBackground는 content 각 분기에 그대로 유지 — WidgetKit이 래핑과 무관하게 인식.
        content.widgetTapRefreshWrap()
    }

    @ViewBuilder
    private var content: some View {
        if let snap = entry.snapshot {
            let scheduled = snap.resolvedStatus == "scheduled" || snap.resolvedStatus == "cancelled"
            switch family {
            case .systemSmall:
                if scheduled {
                    HomeWidgetScheduledCard(snap: snap, compact: true)
                        .widgetContainerBackground { smallBackground(snap) }
                } else {
                    HomeWidgetSmallCard(snap: snap)
                        .widgetContainerBackground { smallBackground(snap) }
                }
            case .systemMedium:
                if scheduled {
                    // 예정/취소 — 라이브 스코어 카드 대신 "다음 경기" 카드 (안드/앱 홈 동일 컨셉)
                    HomeWidgetScheduledCard(snap: snap, compact: false)
                        .widgetContainerBackground { smallBackground(snap) }
                } else {
                    // medium LIVE/FINAL — 잠금화면 Live Activity 카드(KBOLockScreenCard)와 *동일*하게
                    // (하린아빠 요청). 아웃카운트·투수/타자·다이아몬드·풀네임·폰트 전부 잠금화면 그대로.
                    // #278에서 카드를 충분히 컴팩트화해 medium 높이에 수용.
                    KBOLockScreenCard(attributes: attributes(from: snap),
                                      state: state(from: snap),
                                      fillHeight: true,
                                      isStale: snap.isStale == true)
                        .widgetContainerBackground { smallBackground(snap) }
                }
            default:
                if scheduled {
                    HomeWidgetScheduledCard(snap: snap, compact: false)
                        .widgetContainerBackground { smallBackground(snap) }
                } else {
                    // large — 세로 여유가 충분해 잠금화면 카드를 그대로 재사용 (디자인 동일)
                    KBOLockScreenCard(attributes: attributes(from: snap),
                                      state: state(from: snap),
                                      isStale: snap.isStale == true)
                        .padding(8)
                        .widgetContainerBackground { Color(hex: 0x0A0A0B) }
                }
            }
        } else {
            HomeWidgetEmptyCard()
                .widgetContainerBackground { Color(hex: 0x141416) }
        }
    }

    // 스냅샷 → 잠금화면 카드가 쓰는 ActivityAttributes 모델로 변환 (디자인 100% 동일)
    private func attributes(from s: WidgetGameSnapshot) -> KBOGameAttributes {
        KBOGameAttributes(
            gameId: s.gameId,
            awayTeam: teamFullName(s.awayTeamCode),
            homeTeam: teamFullName(s.homeTeamCode),
            awayTeamCode: s.awayTeamCode,
            homeTeamCode: s.homeTeamCode,
            myTeamCode: s.myTeamCode
        )
    }

    private func state(from s: WidgetGameSnapshot) -> KBOGameAttributes.ContentState {
        KBOGameAttributes.ContentState(
            awayScore: s.awayScore,
            homeScore: s.homeScore,
            inning: s.inning,
            isTopInning: s.isTopInning,
            balls: 0,
            strikes: 0,
            outs: s.outs,
            onFirst: s.onFirst,
            onSecond: s.onSecond,
            onThird: s.onThird,
            pitcherName: s.pitcherName,
            batterName: s.batterName,
            stadium: s.stadium,
            status: s.isFinal ? .final : .live,
            lastPlay: s.lastPlay
        )
    }

    private func smallBackground(_ s: WidgetGameSnapshot) -> some View {
        let hasMyTeam = !s.myTeamCode.isEmpty &&
            (s.myTeamCode == s.awayTeamCode || s.myTeamCode == s.homeTeamCode)
        // 잠금화면 카드와 동일한 "어두운 그라데이션" (승인 목업 기준). 하단이 어두워 아웃/주자 점이 또렷.
        return cardGradient(s.myTeamCode, hasMyTeam: hasMyTeam)
    }
}

// MARK: - small 컴팩트 카드 (로고 + 점수 + LIVE 이닝)

@available(iOS 16.1, *)
struct HomeWidgetSmallCard: View {
    let snap: WidgetGameSnapshot

    private var hasMyTeam: Bool {
        !snap.myTeamCode.isEmpty &&
        (snap.myTeamCode == snap.awayTeamCode || snap.myTeamCode == snap.homeTeamCode)
    }

    var body: some View {
        VStack(spacing: 7) {
            if hasMyTeam {
                HStack(spacing: 4) {
                    TeamLogo(code: snap.myTeamCode, size: 13)
                    Text("MY TEAM")
                        .font(montserrat(9, .heavy)).tracking(0.8)
                    Spacer()
                }
                .foregroundStyle(.white.opacity(0.9))
            }

            HStack(spacing: 6) {
                smallTeam(code: snap.awayTeamCode, score: snap.awayScore)
                Text(":")
                    .font(montserrat(14, .bold))
                    .foregroundStyle(.white.opacity(0.5))
                smallTeam(code: snap.homeTeamCode, score: snap.homeScore)
            }

            Group {
                if snap.isStale == true {
                    // B안 — 5h 넘게 갱신 안 된 live 스냅샷: LIVE 떼고 중립 표기('경기 종료' 단정 X,
                    // 스코어가 최종 아닐 수 있음). 앱을 열면 최신화된다.
                    Text("업데이트 필요").font(notoKR(9, .bold))
                } else if snap.isFinal {
                    Text("경기 종료").font(notoKR(9, .bold))
                } else {
                    Text("LIVE ").font(montserrat(9, .bold))
                        + inningRun("\(snap.inning)회\(snap.isTopInning ? "초" : "말")", 9, .bold)
                }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(
                Capsule().fill((snap.isStale == true || snap.isFinal) ? Color.white.opacity(0.18) : Color.red.opacity(0.85))
            )
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(10)
    }

    private func smallTeam(code: String, score: Int) -> some View {
        VStack(spacing: 3) {
            ZStack {
                Circle().fill(.white)
                TeamLogo(code: code, size: 20)
            }
            .frame(width: 30, height: 30)
            Text(teamShortName(code))
                .font(montserrat(11, .heavy))
                .lineLimit(1).minimumScaleFactor(0.7)
            Text("\(score)")
                .font(montserrat(24, .black)).monospacedDigit()
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - 예정/취소 경기 카드 (최애팀 다음 경기 — 라이브 경기 없을 때 fallback)

@available(iOS 16.1, *)
struct HomeWidgetScheduledCard: View {
    let snap: WidgetGameSnapshot
    /// true = systemSmall(컴팩트), false = systemMedium.
    let compact: Bool

    private var isCancelled: Bool { snap.resolvedStatus == "cancelled" }

    private var hasMyTeam: Bool {
        !snap.myTeamCode.isEmpty &&
        (snap.myTeamCode == snap.awayTeamCode || snap.myTeamCode == snap.homeTeamCode)
    }

    /// small pill 문구 — 안드 확정과 동일하게 "{시각} 경기 예정"(시각+상태 결합).
    private var scheduledPill: String {
        if isCancelled { return "경기 취소" }
        let t = snap.startText ?? ""
        return t.isEmpty ? "경기 예정" : "\(t) 경기 예정"
    }

    var body: some View {
        VStack(spacing: compact ? 8 : 10) {
            if hasMyTeam {
                HStack(spacing: 4) {
                    TeamLogo(code: snap.myTeamCode, size: compact ? 13 : 16)
                    Text("MY TEAM")
                        .font(montserrat(compact ? 9 : 11, .heavy)).tracking(compact ? 0.8 : 1.0)
                    Spacer()
                }
                .foregroundStyle(.white.opacity(0.9))
            }

            // 매치업(로고 + 이름). small은 로고 사이 VS만(시각은 아래 그룹). medium은 가운데 컬럼에
            // 안드 승인본과 동일하게 날짜/구장/"경기 예정"(큰 글씨)/시각 pill을 세로로 쌓는다.
            HStack(alignment: compact ? .center : .top, spacing: compact ? 10 : 14) {
                teamColumn(code: snap.awayTeamCode, starter: snap.awayStarter)
                if compact {
                    Text(isCancelled ? "✕" : "VS")
                        .font(montserrat(13, .heavy))
                        .foregroundStyle(.white.opacity(0.6))
                } else {
                    // medium 가운데 — 안드 승인본: 날짜 / 구장 / "경기 예정"(큰 글씨) / 시각 pill.
                    VStack(spacing: 0) {
                        if let d = snap.dateText, !d.isEmpty {
                            mixedScriptText(d, 12, .bold)
                                .foregroundStyle(.white)
                        }
                        if !snap.stadium.isEmpty {
                            Text(snap.stadium)
                                .font(notoKR(11, .medium))
                                .foregroundStyle(.white.opacity(0.8))
                                .padding(.top, 8)
                        }
                        Text(isCancelled ? "경기 취소" : "경기 예정")
                            .font(notoKR(15, .bold))
                            .foregroundStyle(.white)
                            .padding(.top, 9)
                        if let t = snap.startText, !t.isEmpty, !isCancelled {
                            // 시각 pill — 안드 승인본과 색상 통일: 코랄 텍스트(0xFF6B7A) +
                            // 반투명 다크레드 배경(안드 widget_status_pill #33E03545). 기존 검정 pill 교체.
                            Text(t)
                                .font(notoKR(12, .bold))
                                .foregroundStyle(Color(hex: 0xFF6B7A))
                                .padding(.horizontal, 13).padding(.vertical, 5)
                                .background(Capsule().fill(Color(hex: 0xE03545).opacity(0.2)))
                                .padding(.top, 11)
                        }
                    }
                }
                teamColumn(code: snap.homeTeamCode, starter: snap.homeStarter)
            }

            if compact {
                // small — 안드 확정: pill "{시각} 경기 예정"(핑크) + 선발 2줄. pill·선발·매치업 폰트 통일(11).
                VStack(spacing: 15) {
                    Text(scheduledPill)
                        .font(notoKR(11, .bold))
                        .foregroundColor(Color(hex: 0xFF6B7A))
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Capsule().fill(Color.white.opacity(0.16)))
                    if !isCancelled { starterBlockSmall }
                }
            }
            // medium 날짜/구장/"경기 예정"/시각은 위 가운데 컬럼으로 이동(안드 승인본과 동일).
        }
        .foregroundStyle(.white)
        // MY TEAM 상단정렬 + 상단 여백을 좌우보다 작게(안드 확정: "MY TEAM 좀 더 위로").
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, compact ? 12 : 16)
        .padding(.top, compact ? 8 : 10)
        .padding(.bottom, compact ? 12 : 16)
    }

    // 예고선발 라인(small) — 2줄: "선발"(옅은 라벨) / "A vs B". 안드 확정과 동일(폰트 통일).
    private var starterBlockSmall: some View {
        VStack(spacing: 1) {
            Text("선발")
                .font(notoKR(11, .medium)).foregroundColor(.white.opacity(0.65))
            (Text(starterDisplayName(snap.awayStarter)).font(notoKR(11, .semibold)).foregroundColor(.white.opacity(0.95))
             + Text(" vs ").font(montserrat(10, .semibold)).foregroundColor(.white.opacity(0.5))
             + Text(starterDisplayName(snap.homeStarter)).font(notoKR(11, .semibold)).foregroundColor(.white.opacity(0.95)))
                .lineLimit(1).minimumScaleFactor(0.7)
        }
    }

    private func teamColumn(code: String, starter: String? = nil) -> some View {
        // medium: 풀네임(롯데 자이언츠/LG 트윈스) + 로고·팀명 25%↑(하린아빠 요청). 라틴=Montserrat,
        // 한글=Noto 글자단위 분리. compact(small 위젯)는 공간 제약상 약어 유지.
        // ⚠️ 풀네임은 한 줄에 안 들어가 minimumScaleFactor로 쪼그라들면 오히려 작아진다 →
        //    medium은 2줄 허용(롯데/자이언츠). 안드 승인본(14sp)에 맞춰 14pt로 축소(하린아빠 "너무 큼").
        let name: Text = compact
            ? Text(teamShortName(code)).font(montserrat(11, .heavy))
            : mixedScriptText(teamFullName(code), 14, .heavy)
        return VStack(spacing: 3) {
            ZStack {
                Circle().fill(.white)
                TeamLogo(code: code, size: compact ? 22 : 31)
            }
            .frame(width: compact ? 32 : 45, height: compact ? 32 : 45)
            name
                .multilineTextAlignment(.center)
                .lineLimit(compact ? 1 : 2)
                .minimumScaleFactor(compact ? 0.7 : 0.85)
                .fixedSize(horizontal: false, vertical: true)
            // medium: 각 팀 풀네임 아래 예고선발 투수 이름(안드 확정). 미확정이면 "미정".
            if !compact {
                Text(starterDisplayName(starter))
                    .font(notoKR(12, .semibold))
                    .foregroundColor(.white.opacity(0.72))
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .padding(.top, 1)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - 빈 상태

@available(iOS 16.1, *)
struct HomeWidgetEmptyCard: View {
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "baseball")
                .font(.system(size: 22))
                .foregroundStyle(.white.opacity(0.4))
            Text("경기 정보가 없어요")
                .font(notoKR(12, .medium))
                .foregroundStyle(.white.opacity(0.6))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Widget 정의

@available(iOS 16.1, *)
struct KBOHomeWidget: Widget {
    let kind = "KBOHomeWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GameWidgetProvider()) { entry in
            KBOHomeWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("크보팬 경기")
        .description("최애팀 경기 스코어를 홈 화면에서 바로 확인하세요.")
        .supportedFamilies([.systemSmall, .systemMedium])
        // 기본 content margins를 끄면 containerBackground 그라데이션이 위젯 가장자리까지
        // 꽉 찬다(이전엔 기본 여백 때문에 카드 둘레에 검은 테두리가 보였다). 콘텐츠는
        // 각 카드의 자체 내부 패딩으로 가장자리에 붙지 않는다.
        .contentMarginsDisabled()
    }
}
