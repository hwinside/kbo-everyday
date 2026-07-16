//
//  KBOWatchGameComplication.swift
//  최애팀 경기 컴플리케이션 — accessoryRectangular(1순위) / Circular / Inline.
//
//  TimelineProvider가 /api/games·/api/standings를 직접 fetch해 라이브 스코어·상황과
//  순위(`2위 · 1위와 1.5경기차`)를 워치페이스에 상시 표시한다. 갤러리 미리보기는 익명 더미
//  (수달스/돌고래스 — 폰 위젯 미리보기 폴리시와 동일).
//

import SwiftUI
import WidgetKit

// MARK: - 엔트리

struct GameEntry: TimelineEntry {
    let date: Date
    let snap: WatchSnapshot
}

// MARK: - Provider

struct GameProvider: TimelineProvider {
    func placeholder(in context: Context) -> GameEntry {
        GameEntry(date: Date(), snap: .previewDummy())
    }

    func getSnapshot(in context: Context, completion: @escaping (GameEntry) -> Void) {
        if context.isPreview {
            completion(GameEntry(date: Date(), snap: .previewDummy()))
            return
        }
        if let cached = WatchStore.loadCachedSnapshot() {
            completion(GameEntry(date: Date(), snap: cached))
            return
        }
        WatchFetcher.fetch { snap in
            completion(GameEntry(date: Date(), snap: snap))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GameEntry>) -> Void) {
        WatchFetcher.fetch { snap in
            let now = Date()
            // 오늘 예정 경기: 시작까지 카운트다운(원형)이 촘촘히 갱신되도록 다중 엔트리를 미리 만든다.
            // fetch 1회로 표시만 순차 갱신 → refresh 예산 소모 0. 시작 시각에 refetch로 라이브 전환.
            if snap.kind == "scheduled", let start = snap.startAt, start > now,
               WatchFetcher.isCountdownToday(start: start, ref: now) {
                var entries: [GameEntry] = []
                var t = now
                while t < start && entries.count < 240 {
                    entries.append(GameEntry(date: t, snap: snap))
                    // 시작 1시간 전부터 1분 간격, 그 이전은 5분 간격(엔트리 수 억제).
                    t = t.addingTimeInterval(start.timeIntervalSince(t) <= 3600 ? 60 : 300)
                }
                if entries.isEmpty { entries.append(GameEntry(date: now, snap: snap)) }
                completion(Timeline(entries: entries, policy: .after(start)))
                return
            }
            // watchOS 컴플리케이션 refresh 예산이 빡빡해(일 수십 회) 라이브만 짧게 잡는다.
            // 단, 예정 시작 시각이 지났는데 API가 아직 scheduled로 남아있으면(반영 지연)
            // 30분까지 기다리지 않도록 짧게 재시도해 '곧 시작'이 오래 남는 것을 방지한다.
            // "오늘"(isCountdownToday) 가드로 전날 stale scheduled 캐시가 4분 retry로 도는 것 차단.
            let startedButStillScheduled = snap.kind == "scheduled"
                && (snap.startAt.map { $0 <= now && WatchFetcher.isCountdownToday(start: $0, ref: now) } ?? false)
            let interval: TimeInterval = snap.isLive ? 10 * 60 : (startedButStillScheduled ? 4 * 60 : 30 * 60)
            completion(Timeline(entries: [GameEntry(date: now, snap: snap)],
                                policy: .after(now.addingTimeInterval(interval))))
        }
    }
}

// MARK: - 표기 헬퍼

private func displayName(_ code: String) -> String {
    // 더미 스냅샷은 code 자리에 이미 표시명(수달스 등)이 들어있다.
    let short = WatchTeam.short(code)
    return short.isEmpty ? code : short
}

// MARK: - 컴플리케이션 뷰 (family별 분기)

struct KBOWatchComplicationView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode
    let entry: GameEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryRectangular: rectangular
            case .accessoryCircular:    circular
            case .accessoryInline:      inline
            default:                    rectangular
            }
        }
        .containerBackground(for: .widget) { Color.clear }
    }

    private var snap: WatchSnapshot { entry.snap }

    /// tint(accented/vibrant) 모드 판정 — watchOS는 widgetAccentedRenderingMode(.fullColor)를 무시하므로
    /// (Apple 공식 문서, iOS 전용 모디파이어) 버전 분기 없이 renderingMode로만 판정한다.
    private var canShowLogo: Bool {
        renderingMode == .fullColor
    }

    /// 팀 로고 — 워치앱 카드와 동일 teamlogo_* 흰 원형 칩(위젯 타깃 에셋 사본).
    /// 미지의 코드(익명 더미 등)는 미렌더. 삼순 스펙: 직사각형 16pt 좌우 배치.
    /// tint(accented/vibrant) 모드에선 canShowLogo가 false라 이 함수가 아예 호출 경로에서 걸러짐(텍스트 폴백만 노출).
    @ViewBuilder private func teamLogo(_ code: String, size: CGFloat = 16) -> some View {
        if let asset = WatchTeam.logoAsset(code), canShowLogo {
            Image(asset)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
        }
    }

    // 직사각형 — 정보량 최대(1순위). [로고]매치업[로고] + 상황 + 순위.
    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            if snap.hasScore {
                HStack(spacing: 4) {
                    teamLogo(snap.awayCode)
                    watchMixedText(displayName(snap.awayCode), 14, .bold)
                    Text("\(snap.awayScore):\(snap.homeScore)")
                        .font(watchMontserrat(16, .black))
                    watchMixedText(displayName(snap.homeCode), 14, .bold)
                    teamLogo(snap.homeCode)
                }
                .lineLimit(1).minimumScaleFactor(0.7)
            } else if snap.kind == "scheduled" || snap.kind == "cancelled" {
                HStack(spacing: 4) {
                    teamLogo(snap.awayCode)
                    watchMixedText("\(displayName(snap.awayCode)) vs \(displayName(snap.homeCode))", 14, .bold)
                    teamLogo(snap.homeCode)
                }
                .lineLimit(1).minimumScaleFactor(0.7)
            } else {
                watchMixedText(snap.kind == "noTeam" ? "크보팬" : displayName(snap.myTeamCode), 14, .bold)
            }

            HStack(spacing: 4) {
                watchMixedText(snap.kind == "noTeam" ? "앱에서 팀 선택" : snap.line, 12, .medium)
                    .foregroundStyle(snap.isLive ? Color(red: 1.0, green: 0.42, blue: 0.48) : .secondary)
                    .lineLimit(1).minimumScaleFactor(0.75)
                if snap.isLive, let b = snap.bases, b.any {
                    BaseDiamond(bases: b, size: 13)
                }
            }

            if !snap.rankLine.isEmpty {
                watchMixedText(snap.rankLine, 12, .semibold)
                    .foregroundStyle(.secondary)
                    .lineLimit(1).minimumScaleFactor(0.75)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // 원형 상대팀 축약(내 팀 아닌 쪽).
    private var opponentShort: String {
        let opp = snap.awayCode == snap.myTeamCode ? snap.homeCode : snap.awayCode
        return displayName(opp)
    }

    // 원형 라이브 스코어 한 줄: "LG 3" (팀 + 점수). 누가 몇 점인지 명확하게.
    private func circularScoreRow(_ team: String, _ score: Int) -> some View {
        HStack(spacing: 4) {
            watchMixedText(team, 11, .bold)
            Text("\(score)").font(watchMontserrat(14, .black))
        }
        .lineLimit(1).minimumScaleFactor(0.55)
    }

    // 원형 — 스코어(라이브/종료) / 예정경기(vs 상대 + 카운트다운·날짜) / 순위(그 외).
    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 1) {
                if snap.hasScore {
                    // 팀별로 점수를 라벨 → "LG 3 / KT 2" (my팀 위, 상대 아래). 내 팀 없으면 원정/홈 순.
                    if snap.myTeamCode.isEmpty {
                        circularScoreRow(displayName(snap.awayCode), snap.awayScore)
                        circularScoreRow(displayName(snap.homeCode), snap.homeScore)
                    } else {
                        let myAway = snap.awayCode == snap.myTeamCode
                        circularScoreRow(displayName(snap.myTeamCode), myAway ? snap.awayScore : snap.homeScore)
                        circularScoreRow(displayName(myAway ? snap.homeCode : snap.awayCode),
                                         myAway ? snap.homeScore : snap.awayScore)
                    }
                } else if snap.kind == "scheduled" {
                    watchMixedText(opponentShort.isEmpty ? "예정" : "vs \(opponentShort)", 11, .heavy)
                        .lineLimit(1).minimumScaleFactor(0.6)
                    watchMixedText(WatchFetcher.circularScheduleLabel(startAt: snap.startAt, ref: entry.date), 13, .black)
                        .foregroundStyle(WatchFetcher.isCountdownImminent(startAt: snap.startAt, ref: entry.date)
                                         ? Color(red: 1.0, green: 0.58, blue: 0.0) : Color.primary)
                        .lineLimit(1).minimumScaleFactor(0.6)
                } else {
                    // 비경기(순위) 상태만 최애팀 로고 1개 — 삼순 스펙(양팀 로고는 원형 가독성 훼손).
                    // tint(accented/vibrant) 모드에선 로고 대신 팀명 텍스트 폴백(canShowLogo).
                    if WatchTeam.logoAsset(snap.myTeamCode) != nil, canShowLogo {
                        teamLogo(snap.myTeamCode, size: 18)
                    } else {
                        watchMixedText(snap.myTeamCode.isEmpty ? "KBO" : displayName(snap.myTeamCode), 10, .heavy)
                            .lineLimit(1).minimumScaleFactor(0.6)
                    }
                    watchMixedText(snap.rankLine.isEmpty ? "-" : String(snap.rankLine.prefix(2)), 14, .black)
                        .lineLimit(1).minimumScaleFactor(0.6)
                }
            }
        }
    }

    // 인라인 — 시계 위 한 줄.
    private var inline: some View {
        Group {
            if snap.hasScore {
                watchMixedText("\(displayName(snap.awayCode)) \(snap.awayScore):\(snap.homeScore) \(displayName(snap.homeCode))", 13, .medium)
            } else if snap.kind == "scheduled" {
                watchMixedText("\(snap.line) \(displayName(snap.awayCode)) vs \(displayName(snap.homeCode))", 13, .medium)
            } else if !snap.rankLine.isEmpty {
                watchMixedText("\(displayName(snap.myTeamCode)) \(snap.rankLine)", 13, .medium)
            } else {
                watchMixedText("크보팬", 13, .medium)
            }
        }
    }
}

// MARK: - Widget 선언

struct KBOWatchGameComplication: Widget {
    let kind = "KBOWatchGameComplication"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GameProvider()) { entry in
            KBOWatchComplicationView(entry: entry)
        }
        .configurationDisplayName("크보팬 경기")
        .description("최애팀 경기 스코어·순위를 워치페이스에 표시합니다.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}
