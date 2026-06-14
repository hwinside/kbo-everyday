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
    /// 예정/취소 경기 표시용 시각 문구(예: "18:30"). live/final이면 빈 문자열.
    var startText: String? = nil
    /// 예정 경기 날짜 라벨(예: "6월 7일 (토)"). 구장 위에 표시. scheduled에서만.
    var dateText: String? = nil

    /// 렌더 분기용 정규화 상태.
    var resolvedStatus: String {
        if let s = status, !s.isEmpty { return s }
        return isFinal ? "final" : "live"
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

// 미리보기/플레이스홀더용 더미 경기
private let sampleSnapshot = WidgetGameSnapshot(
    hasGame: true, gameId: "SAMPLE", awayTeamCode: "SK", homeTeamCode: "LG",
    myTeamCode: "LG", awayScore: 3, homeScore: 5, inning: 7, isTopInning: false,
    outs: 1, onFirst: true, onSecond: false, onThird: true,
    pitcherName: "웰스", batterName: "오스틴", stadium: "잠실", isFinal: false
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
        let entry = GameWidgetEntry(date: Date(), snapshot: loadSnapshot())
        // 앱이 reloadAllTimelines()로 즉시 갱신하지만, 백그라운드 폴백으로 15분마다 재요청.
        let next = Date().addingTimeInterval(15 * 60)
        completion(Timeline(entries: [entry], policy: .after(next)))
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
                                      fillHeight: true)
                        .widgetContainerBackground { smallBackground(snap) }
                }
            default:
                if scheduled {
                    HomeWidgetScheduledCard(snap: snap, compact: false)
                        .widgetContainerBackground { smallBackground(snap) }
                } else {
                    // large — 세로 여유가 충분해 잠금화면 카드를 그대로 재사용 (디자인 동일)
                    KBOLockScreenCard(attributes: attributes(from: snap),
                                      state: state(from: snap))
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
            status: s.isFinal ? .final : .live
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
                if snap.isFinal {
                    Text("경기 종료").font(notoKR(9, .bold))
                } else {
                    Text("LIVE ").font(montserrat(9, .bold))
                        + inningRun("\(snap.inning)회\(snap.isTopInning ? "초" : "말")", 9, .bold)
                }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(
                Capsule().fill(snap.isFinal ? Color.white.opacity(0.18) : Color.red.opacity(0.85))
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

    /// 가운데 라벨: 취소면 "경기 취소", 예정이면 시각(없으면 "경기 예정").
    private var centerLabel: String {
        if isCancelled { return "경기 취소" }
        let t = snap.startText ?? ""
        return t.isEmpty ? "경기 예정" : t
    }

    var body: some View {
        VStack(spacing: compact ? 7 : 10) {
            if hasMyTeam {
                HStack(spacing: 4) {
                    TeamLogo(code: snap.myTeamCode, size: compact ? 13 : 16)
                    Text("MY TEAM")
                        .font(montserrat(compact ? 9 : 11, .heavy)).tracking(compact ? 0.8 : 1.0)
                    Spacer()
                }
                .foregroundStyle(.white.opacity(0.9))
            }

            HStack(spacing: compact ? 8 : 14) {
                teamColumn(code: snap.awayTeamCode)
                VStack(spacing: 3) {
                    Text(isCancelled ? "✕" : "VS")
                        .font(montserrat(compact ? 13 : 16, .heavy))
                        .foregroundStyle(.white.opacity(0.7))
                    Text(centerLabel)
                        .font(notoKR(compact ? 9 : 11, .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, compact ? 7 : 9).padding(.vertical, 2)
                        .background(Capsule().fill(Color.white.opacity(0.18)))
                }
                teamColumn(code: snap.homeTeamCode)
            }

            // medium에서만 날짜('6월 7일 (토)') + 구장 표기. 날짜 숫자=Montserrat 분리.
            if !compact {
                if let d = snap.dateText, !d.isEmpty {
                    mixedScriptText(d, 11, .semibold)
                        .foregroundStyle(.white.opacity(0.85))
                }
                if !snap.stadium.isEmpty {
                    Text(snap.stadium)
                        .font(notoKR(11, .medium))
                        .foregroundStyle(.white.opacity(0.8))
                }
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(compact ? 10 : 14)
    }

    private func teamColumn(code: String) -> some View {
        // medium: 풀네임(롯데 자이언츠/LG 트윈스) + 로고·팀명 25%↑(하린아빠 요청). 라틴=Montserrat,
        // 한글=Noto 글자단위 분리. compact(small 위젯)는 공간 제약상 약어 유지.
        let name: Text = compact
            ? Text(teamShortName(code)).font(montserrat(11, .heavy))
            : mixedScriptText(teamFullName(code), 16, .heavy)
        return VStack(spacing: 3) {
            ZStack {
                Circle().fill(.white)
                TeamLogo(code: code, size: compact ? 22 : 35)
            }
            .frame(width: compact ? 32 : 50, height: compact ? 32 : 50)
            name
                .lineLimit(1).minimumScaleFactor(0.55)
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
