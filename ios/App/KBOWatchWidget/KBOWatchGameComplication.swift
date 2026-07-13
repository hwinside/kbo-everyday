//
//  KBOWatchGameComplication.swift
//  최애팀 경기 컴플리케이션 — accessoryRectangular(1순위) / Circular / Inline.
//
//  TimelineProvider가 /api/games·/api/standings를 직접 fetch해 라이브 스코어·상황과
//  순위(`2위 · 1.5G`)를 워치페이스에 상시 표시한다. 갤러리 미리보기는 익명 더미
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
            let interval: TimeInterval = snap.isLive ? 10 * 60 : 30 * 60
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

    // 직사각형 — 정보량 최대(1순위). 스코어/매치업 + 상황 + 순위.
    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            if snap.hasScore {
                HStack(spacing: 4) {
                    Text(displayName(snap.awayCode)).font(.system(size: 14, weight: .bold))
                    Text("\(snap.awayScore):\(snap.homeScore)")
                        .font(.system(size: 16, weight: .black)).monospacedDigit()
                    Text(displayName(snap.homeCode)).font(.system(size: 14, weight: .bold))
                }
                .lineLimit(1).minimumScaleFactor(0.7)
            } else if snap.kind == "scheduled" || snap.kind == "cancelled" {
                Text("\(displayName(snap.awayCode)) vs \(displayName(snap.homeCode))")
                    .font(.system(size: 14, weight: .bold))
                    .lineLimit(1).minimumScaleFactor(0.7)
            } else {
                Text(snap.kind == "noTeam" ? "크보팬" : displayName(snap.myTeamCode))
                    .font(.system(size: 14, weight: .bold))
            }

            Text(snap.kind == "noTeam" ? "앱에서 팀 선택" : snap.line)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(snap.isLive ? Color(red: 1.0, green: 0.42, blue: 0.48) : .secondary)
                .lineLimit(1).minimumScaleFactor(0.75)

            if !snap.rankLine.isEmpty {
                Text(snap.rankLine)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // 원형 상대팀 축약(내 팀 아닌 쪽).
    private var opponentShort: String {
        let opp = snap.awayCode == snap.myTeamCode ? snap.homeCode : snap.awayCode
        return displayName(opp)
    }

    // 원형 — 스코어(라이브/종료) / 예정경기(vs 상대 + 카운트다운·날짜) / 순위(그 외).
    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                if snap.hasScore {
                    Text(snap.myTeamCode.isEmpty ? "KBO" : displayName(snap.myTeamCode))
                        .font(.system(size: 10, weight: .heavy))
                        .lineLimit(1).minimumScaleFactor(0.6)
                    Text("\(snap.awayScore):\(snap.homeScore)")
                        .font(.system(size: 15, weight: .black)).monospacedDigit()
                        .lineLimit(1).minimumScaleFactor(0.6)
                } else if snap.kind == "scheduled" {
                    Text(opponentShort.isEmpty ? "예정" : "vs \(opponentShort)")
                        .font(.system(size: 11, weight: .heavy))
                        .lineLimit(1).minimumScaleFactor(0.6)
                    Text(WatchFetcher.circularScheduleLabel(startAt: snap.startAt, ref: entry.date))
                        .font(.system(size: 13, weight: .black)).monospacedDigit()
                        .lineLimit(1).minimumScaleFactor(0.6)
                } else {
                    Text(snap.myTeamCode.isEmpty ? "KBO" : displayName(snap.myTeamCode))
                        .font(.system(size: 10, weight: .heavy))
                        .lineLimit(1).minimumScaleFactor(0.6)
                    Text(snap.rankLine.isEmpty ? "-" : String(snap.rankLine.prefix(2)))
                        .font(.system(size: 14, weight: .black))
                        .lineLimit(1).minimumScaleFactor(0.6)
                }
            }
        }
    }

    // 인라인 — 시계 위 한 줄.
    private var inline: some View {
        Group {
            if snap.hasScore {
                Text("\(displayName(snap.awayCode)) \(snap.awayScore):\(snap.homeScore) \(displayName(snap.homeCode))")
            } else if snap.kind == "scheduled" {
                Text("\(snap.line) \(displayName(snap.awayCode)) vs \(displayName(snap.homeCode))")
            } else if !snap.rankLine.isEmpty {
                Text("\(displayName(snap.myTeamCode)) \(snap.rankLine)")
            } else {
                Text("크보팬")
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
