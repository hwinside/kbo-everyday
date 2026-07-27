//
//  KBOTeamRankWidget.swift
//  KBO 크보팬 — 팀 순위표 홈 위젯 (WidgetKit StaticConfiguration, systemLarge 전용)
//
//  안드로이드 TeamRankWidget(renderTable)의 iOS판. 컬럼 #/팀/승/패/무/승률/차/연속을
//  다크(#0A0A0B) 배경에 그대로 옮기고, 최애팀 행은 팀컬러 α0.094 밴드 + 좌측 3pt 팀컬러
//  바로 하이라이트한다. 데이터는 /api/standings를 위젯이 직접 fetch(30분) + App Group 캐시
//  폴백. 폰트/로고/컬러 헬퍼는 KBOLiveActivityWidget.swift 것을 재사용(단일 소스).
//

import SwiftUI
import WidgetKit

// MARK: - App Group

private let kRankAppGroup = "group.fan.keubo.app"
private let kRankCacheKey = "kbo_rank_rows"        // /api/standings 응답 원문 캐시
private let kSnapshotKeyForRank = "kbo_widget_snapshot"  // 최애팀 코드 재사용

// MARK: - iOS 17 containerBackground 호환 (홈 위젯과 동일 헬퍼 — 파일 스코프 분리)

extension View {
    @ViewBuilder
    func widgetBG<B: View>(@ViewBuilder _ bg: () -> B) -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(for: .widget) { bg() }
        } else {
            self.background(bg())
        }
    }
}

// MARK: - teamId 매핑 (안드 CODE_BY_ID / HL_BY_ID 이식). 로고 코드는 iOS TeamLogo 규격(대문자).

@available(iOS 16.1, *)
func rankTeamCode(_ teamId: Int) -> String {
    switch teamId {
    case 1: return "LG"
    case 2: return "OB"
    case 3: return "KT"
    case 4: return "SK"
    case 5: return "NC"
    case 6: return "HT"
    case 7: return "LT"
    case 8: return "SS"
    case 9: return "HH"
    case 10: return "WO"
    default: return ""
    }
}

@available(iOS 16.1, *)
func rankTeamId(fromCode code: String) -> Int {
    switch code.uppercased() {
    case "LG": return 1
    case "OB": return 2
    case "KT": return 3
    case "SK": return 4
    case "NC": return 5
    case "HT": return 6
    case "LT": return 7
    case "SS": return 8
    case "HH": return 9
    case "WO": return 10
    default: return 0
    }
}

/// 최애팀 하이라이트 컬러 — 안드 HL_BY_ID(다크 getTeamBgColor 실효값)와 동일.
@available(iOS 16.1, *)
func rankHighlightHex(_ teamId: Int) -> UInt32? {
    switch teamId {
    case 1: return 0xC60C30
    case 2: return 0x9BA8D4
    case 3: return 0xE85050
    case 4: return 0xCE0E2D
    case 5: return 0x315288
    case 6: return 0xEA0029
    case 7: return 0x6BC4E8
    case 8: return 0x074CA1
    case 9: return 0xFF6600
    case 10: return 0xC97088
    default: return nil
    }
}

// MARK: - 데이터 모델

/// /api/standings의 standings 배열 원소. null/누락 방어 위해 커스텀 디코딩.
struct RankRow: Codable {
    var teamId: Int
    var ranking: Int
    var teamName: String
    var wins: Int
    var losses: Int
    var draws: Int
    var winRate: Double
    var gamesBehind: Double
    var continuousGameResult: String

    enum CodingKeys: String, CodingKey {
        case teamId, ranking, teamName, wins, losses, draws, winRate, gamesBehind, continuousGameResult
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        teamId = (try? c.decodeIfPresent(Int.self, forKey: .teamId)) ?? 0
        ranking = (try? c.decodeIfPresent(Int.self, forKey: .ranking)) ?? 0
        teamName = (try? c.decodeIfPresent(String.self, forKey: .teamName)) ?? ""
        wins = (try? c.decodeIfPresent(Int.self, forKey: .wins)) ?? 0
        losses = (try? c.decodeIfPresent(Int.self, forKey: .losses)) ?? 0
        draws = (try? c.decodeIfPresent(Int.self, forKey: .draws)) ?? 0
        winRate = (try? c.decodeIfPresent(Double.self, forKey: .winRate)) ?? 0
        gamesBehind = (try? c.decodeIfPresent(Double.self, forKey: .gamesBehind)) ?? 0
        continuousGameResult = (try? c.decodeIfPresent(String.self, forKey: .continuousGameResult)) ?? ""
    }
    // 미리보기 더미 생성용
    init(teamId: Int, ranking: Int, teamName: String, wins: Int, losses: Int,
         draws: Int, winRate: Double, gamesBehind: Double, continuousGameResult: String) {
        self.teamId = teamId; self.ranking = ranking; self.teamName = teamName
        self.wins = wins; self.losses = losses; self.draws = draws
        self.winRate = winRate; self.gamesBehind = gamesBehind
        self.continuousGameResult = continuousGameResult
    }
}

private struct StandingsResponse: Codable { var standings: [RankRow] }

/// 렌더에 필요한 형태로 해석된 행(로고 코드 + 하이라이트 컬러 사전 계산). 뷰는 이 값만 그린다.
struct RankDisplayRow {
    var rank: Int
    var code: String          // "" = 로고 없음(더미)
    var name: String
    var wins: Int
    var losses: Int
    var draws: Int
    var winRate: Double
    var gamesBehind: Double
    var streak: String
    var highlightHex: UInt32? // nil = 하이라이트 없음
}

// MARK: - 표기 포맷 (안드 pctLabel/gbLabel 이식)

/// 승률 ".617" (1 이상이면 "1.000").
private func pctLabel(_ pct: Double) -> String {
    if pct >= 1 { return "1.000" }
    let s = String(format: "%.3f", pct)
    return String(s.dropFirst())  // 앞 "0" 제거 → ".617"
}

/// 게임차 0 → "-", 정수는 소수점 없이, 그 외 한 자리("6.5").
private func gbLabel(_ gb: Double) -> String {
    if gb == 0 { return "-" }
    if gb == gb.rounded(.down) { return String(Int(gb)) }
    return String(format: "%.1f", gb)
}

// MARK: - 최애팀 코드 로드 ("my_team" 직접 기록 우선, 없으면 홈 위젯 스냅샷 폴백)

private let kMyTeamDirectKey = "my_team"

/// LiveActivityPlugin.setMyTeam이 팀 변경 시 직접 기록하는 값을 최우선으로 읽는다.
/// 오프데이/경기데이터 없음/팀변경 직후엔 스냅샷이 stale일 수 있어 direct write가 SSOT.
@available(iOS 16.1, *)
private func loadMyTeamCode() -> String {
    guard let ud = UserDefaults(suiteName: kRankAppGroup) else { return "" }
    if let direct = ud.string(forKey: kMyTeamDirectKey), !direct.isEmpty {
        return direct
    }
    guard let data = ud.data(forKey: kSnapshotKeyForRank),
          let snap = try? JSONDecoder().decode(WidgetGameSnapshot.self, from: data) else {
        return ""
    }
    return snap.myTeamCode
}

// MARK: - 순위 fetch/캐시

@available(iOS 16.1, *)
private func decodeRankCache() -> [RankRow]? {
    guard let ud = UserDefaults(suiteName: kRankAppGroup),
          let data = ud.data(forKey: kRankCacheKey),
          let resp = try? JSONDecoder().decode(StandingsResponse.self, from: data),
          !resp.standings.isEmpty else {
        return nil
    }
    return resp.standings
}

/// /api/standings GET(8초 타임아웃). 성공 시 App Group 캐시 갱신 후 rows 반환, 실패 시 캐시 폴백.
@available(iOS 16.1, *)
private func fetchStandings(completion: @escaping ([RankRow]) -> Void) {
    guard let url = URL(string: "https://keubo.fan/api/standings") else {
        completion(decodeRankCache() ?? []); return
    }
    var req = URLRequest(url: url)
    req.timeoutInterval = 8
    req.setValue("kbo-everyday-widget/1.0", forHTTPHeaderField: "User-Agent")
    URLSession.shared.dataTask(with: req) { data, resp, _ in
        if let data,
           let http = resp as? HTTPURLResponse, http.statusCode == 200,
           let parsed = try? JSONDecoder().decode(StandingsResponse.self, from: data),
           !parsed.standings.isEmpty {
            UserDefaults(suiteName: kRankAppGroup)?.set(data, forKey: kRankCacheKey)
            completion(parsed.standings)
        } else {
            completion(decodeRankCache() ?? [])
        }
    }.resume()
}

/// RankRow(API/캐시) → 렌더용 RankDisplayRow(로고 코드 + 최애팀 하이라이트 해석).
/// `ranking`이 0(HTML fallback 응답 등 미제공)이면 index+1로 대체 — 안드
/// TeamRankWidget.java의 `s.optInt("ranking", i + 1)`과 동일한 폴백.
@available(iOS 16.1, *)
private func resolveRows(_ rows: [RankRow], myTeamId: Int) -> [RankDisplayRow] {
    rows.enumerated().map { i, r in
        let hl: UInt32? = (r.teamId == myTeamId && myTeamId >= 1 && myTeamId <= 10)
            ? rankHighlightHex(r.teamId) : nil
        return RankDisplayRow(
            rank: r.ranking > 0 ? r.ranking : i + 1, code: rankTeamCode(r.teamId), name: r.teamName,
            wins: r.wins, losses: r.losses, draws: r.draws,
            winRate: r.winRate, gamesBehind: r.gamesBehind,
            streak: r.continuousGameResult.trimmingCharacters(in: .whitespaces),
            highlightHex: hl
        )
    }
}

// MARK: - 미리보기 더미 (안드 미리보기 느낌: 55-32-3 .632부터 하향, 로고 없음, 1위 코랄 하이라이트)

@available(iOS 16.1, *)
private func previewRows() -> [RankDisplayRow] {
    let names = ["수달스", "고래스", "여우스", "판다스", "해달스",
                 "라쿤스", "올빼미스", "코알라스", "펭귄스", "돌고래스"]
    var out: [RankDisplayRow] = []
    for (i, name) in names.enumerated() {
        let wins = 55 - i * 3
        let losses = 32 + i * 3
        let draws = 3
        let rate = Double(wins) / Double(max(1, wins + losses))
        let gb = Double(i) * 2.5
        let streak = i % 3 == 0 ? "\(3 - i % 3)승" : (i % 2 == 0 ? "\(i % 3 + 1)패" : "-")
        out.append(RankDisplayRow(
            rank: i + 1, code: "", name: name,
            wins: wins, losses: losses, draws: draws,
            winRate: rate, gamesBehind: gb, streak: streak,
            highlightHex: i == 0 ? 0xE85050 : nil  // 1위 수달스 코랄 하이라이트
        ))
    }
    return out
}

// MARK: - Timeline

struct RankEntry: TimelineEntry {
    let date: Date
    let rows: [RankDisplayRow]
}

@available(iOS 16.1, *)
struct RankProvider: TimelineProvider {
    func placeholder(in context: Context) -> RankEntry {
        RankEntry(date: Date(), rows: previewRows())
    }

    func getSnapshot(in context: Context, completion: @escaping (RankEntry) -> Void) {
        if context.isPreview {
            completion(RankEntry(date: Date(), rows: previewRows()))
            return
        }
        let myId = rankTeamId(fromCode: loadMyTeamCode())
        let cached = decodeRankCache() ?? []
        let rows = cached.isEmpty ? previewRows() : resolveRows(cached, myTeamId: myId)
        completion(RankEntry(date: Date(), rows: rows))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RankEntry>) -> Void) {
        let myId = rankTeamId(fromCode: loadMyTeamCode())
        fetchStandings { rows in
            let display = rows.isEmpty ? previewRows() : resolveRows(rows, myTeamId: myId)
            let next = Date().addingTimeInterval(30 * 60)  // 순위는 일 단위 변동 → 30분 폴백
            let entry = RankEntry(date: Date(), rows: display)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

// MARK: - 색 토큰 (globals.css .dark)

@available(iOS 16.1, *)
private enum RankColor {
    static let bg = Color(hex: 0x0A0A0B)
    static let text = Color(hex: 0xF5F5F7)
    static let secondary = Color(hex: 0xBCBCC1)
    static let tertiary = Color(hex: 0x8E8E93)
    static let headerLine = Color.white.opacity(0.08)
    static let rowLine = Color.white.opacity(0.04)
}

// MARK: - 뷰

@available(iOS 16.1, *)
struct KBOTeamRankWidgetEntryView: View {
    let entry: RankEntry

    // 컬럼 폭(pt) — 우측 수치 컬럼 고정, 팀 컬럼 가변.
    private let wRank: CGFloat = 20
    private let wWin: CGFloat = 28
    private let wLoss: CGFloat = 28
    private let wDraw: CGFloat = 24
    private let wPct: CGFloat = 44
    private let wGb: CGFloat = 30
    private let wStreak: CGFloat = 40

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(RankColor.headerLine).frame(height: 1)
            VStack(spacing: 0) {
                ForEach(Array(entry.rows.enumerated()), id: \.offset) { idx, row in
                    rowView(row, isLast: idx == entry.rows.count - 1)
                }
            }
        }
        // 마진(padding)을 래핑 안에 두어 외곽 마진 탭까지 Button label에 포함 —
        // '새로고침만' 모드(iOS17+)에서 외곽 마진 탭이 앱을 열지 않도록. 배경은 바깥 유지.
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .widgetTapRefreshWrap()
        .widgetBG { RankColor.bg }
    }

    private var header: some View {
        HStack(spacing: 0) {
            Text("#").font(notoKR(11, .semibold)).foregroundStyle(RankColor.tertiary)
                .frame(width: wRank, alignment: .center)
            Text("팀").font(notoKR(11, .semibold)).foregroundStyle(RankColor.tertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 6)
            headerCell("승", wWin)
            headerCell("패", wLoss)
            headerCell("무", wDraw)
            headerCell("승률", wPct)
            headerCell("차", wGb)
            headerCell("연속", wStreak)
        }
        .frame(height: 22)
    }

    private func headerCell(_ t: String, _ w: CGFloat) -> some View {
        Text(t).font(notoKR(11, .semibold)).foregroundStyle(RankColor.tertiary)
            .frame(width: w, alignment: .trailing)
    }

    private func rowView(_ row: RankDisplayRow, isLast: Bool) -> some View {
        HStack(spacing: 0) {
            Text("\(row.rank)")
                .font(montserrat(13, .bold)).foregroundStyle(RankColor.text)
                .frame(width: wRank, alignment: .center)

            HStack(spacing: 5) {
                if !row.code.isEmpty {
                    ZStack {
                        Circle().fill(.white)
                        TeamLogo(code: row.code, size: 18)
                    }
                    .frame(width: 24, height: 24)
                }
                mixedScriptText(row.name, 13, .heavy)
                    .foregroundStyle(RankColor.text)
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 6)

            numCell("\(row.wins)", wWin, RankColor.text, .semibold)
            numCell("\(row.losses)", wLoss, RankColor.text, .semibold)
            numCell("\(row.draws)", wDraw, RankColor.secondary, .semibold)
            numCell(pctLabel(row.winRate), wPct, RankColor.text, .bold)
            numCell(gbLabel(row.gamesBehind), wGb, RankColor.secondary, .semibold)
            streakCell(row.streak, wStreak)
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(alignment: .leading) {
            if let hl = row.highlightHex {
                ZStack(alignment: .leading) {
                    Color(hex: hl).opacity(0.094)
                    Color(hex: hl).frame(width: 3)
                }
                // 하이라이트 밴드를 행 좌우 패딩 바깥까지 채우기 위해 음수 마진
                .padding(.horizontal, -12)
            }
        }
        .overlay(alignment: .bottom) {
            if !isLast {
                Rectangle().fill(RankColor.rowLine).frame(height: 1)
            }
        }
    }

    private func numCell(_ t: String, _ w: CGFloat, _ color: Color, _ weight: Font.Weight) -> some View {
        Text(t).font(montserrat(13, weight)).monospacedDigit()
            .foregroundStyle(color)
            // "10.5" 같은 값이 열 폭을 넘으면 말줄임("10…") 대신 축소 (2026-07-08 QA)
            .lineLimit(1).minimumScaleFactor(0.65)
            .frame(width: w, alignment: .trailing)
    }

    // 연속("5승"/"3패"/"-") — 숫자=Montserrat, 한글=Noto 혼합.
    private func streakCell(_ streak: String, _ w: CGFloat) -> some View {
        let s = streak.isEmpty ? "-" : streak
        return mixedScriptText(s, 13, .semibold)
            .foregroundStyle(streak.isEmpty ? RankColor.secondary : RankColor.text)
            .lineLimit(1)
            .frame(width: w, alignment: .trailing)
    }
}

// MARK: - Widget 정의

@available(iOS 16.1, *)
struct KBOTeamRankWidget: Widget {
    let kind = "KBOTeamRankWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: RankProvider()) { entry in
            KBOTeamRankWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("팀 순위")
        .description("KBO 팀 순위표를 홈 화면에서 바로 확인하세요.")
        .supportedFamilies([.systemLarge])
        .contentMarginsDisabled()
    }
}
