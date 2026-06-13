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
            switch family {
            case .systemSmall:
                HomeWidgetSmallCard(snap: snap)
                    .widgetContainerBackground { smallBackground(snap) }
            default:
                // medium / large — 잠금화면 카드 그대로 재사용 (디자인 동일)
                KBOLockScreenCard(attributes: attributes(from: snap),
                                  state: state(from: snap))
                    .padding(8)
                    .widgetContainerBackground { Color(hex: 0x0A0A0B) }
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
        let accent = hasMyTeam ? teamColor(s.myTeamCode) : Color(hex: 0x1A1A1A)
        return LinearGradient(
            colors: [accent.opacity(0.95), accent.opacity(0.6)],
            startPoint: .topLeading, endPoint: .bottomTrailing
        )
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

            Text(snap.isFinal ? "경기 종료" : "LIVE \(snap.inning)회\(snap.isTopInning ? "초" : "말")")
                .font(notoKR(9, .bold))
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
    }
}
