//
//  KBOPlayerCardWidget.swift
//  KBO 크보팬 — 최애선수 카드 홈 위젯 (WidgetKit AppIntentConfiguration, iOS 17+)
//
//  안드로이드 PlayerCardWidget(renderCard)의 iOS판. 히어로샷 + 헤드라인(최근 페이스) +
//  주간 스파크라인 + 시즌 라인 + 부문 타이틀 뱃지, 오늘 경기 있으면 활약 섹션 우선.
//  선수는 iOS 17 AppIntent(WidgetConfigurationIntent)로 선택 — 후보 목록은 앱이 App Group
//  (group.fan.keubo.app) fav_players JSON에 동기화한 최애선수에서 읽는다(DynamicOptions).
//  데이터는 /api/widget/player-card를 위젯이 직접 fetch(30분) + App Group 파일/캐시 폴백.
//  폰트/로고/컬러 헬퍼는 KBOLiveActivityWidget.swift·KBOTeamRankWidget.swift 것 재사용.
//

import SwiftUI
import WidgetKit
import AppIntents
import UIKit
import ImageIO

// MARK: - App Group

private let kPCAppGroup = "group.fan.keubo.app"
private let kFavPlayersKey = "fav_players"   // 앱이 동기화한 최애선수 목록 JSON
private let kPCBase = "https://keubo.fan"

// MARK: - 최애선수 목록 (App Group fav_players — FavoritePlayer[] JSON)

/// fav_players 원소 = src/lib/store/favorites.ts FavoritePlayer {playerId,name,teamId,position,number}.
private struct FavPlayerRaw: Codable {
    var playerId: String
    var name: String
    var position: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // playerId는 숫자로 직렬화될 수도 있어 문자열/정수 모두 허용
        if let s = try? c.decode(String.self, forKey: .playerId) {
            playerId = s
        } else if let n = try? c.decode(Int.self, forKey: .playerId) {
            playerId = String(n)
        } else { playerId = "" }
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        position = try? c.decodeIfPresent(String.self, forKey: .position)
    }
    enum CodingKeys: String, CodingKey { case playerId, name, position }
}

private func loadFavPlayers() -> [FavPlayerRaw] {
    guard let ud = UserDefaults(suiteName: kPCAppGroup) else { return [] }
    // JSON은 문자열 또는 Data 어느 쪽으로도 저장될 수 있어 둘 다 시도.
    var data: Data?
    if let s = ud.string(forKey: kFavPlayersKey) { data = s.data(using: .utf8) }
    if data == nil { data = ud.data(forKey: kFavPlayersKey) }
    guard let data,
          let arr = try? JSONDecoder().decode([FavPlayerRaw].self, from: data) else { return [] }
    return arr.filter { !$0.playerId.isEmpty && !$0.name.isEmpty }
}

// MARK: - AppIntent (선수 선택)

@available(iOS 17.0, *)
struct FavPlayerEntity: AppEntity {
    let id: String        // playerId(kboId)
    var name: String
    var position: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "최애선수"
    var displayRepresentation: DisplayRepresentation {
        position.isEmpty
            ? DisplayRepresentation(title: "\(name)")
            : DisplayRepresentation(title: "\(name)", subtitle: "\(position)")
    }
    static var defaultQuery = FavPlayerQuery()
}

@available(iOS 17.0, *)
struct FavPlayerQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [FavPlayerEntity] {
        loadFavPlayers()
            .filter { identifiers.contains($0.playerId) }
            .map { FavPlayerEntity(id: $0.playerId, name: $0.name, position: $0.position ?? "") }
    }
    func suggestedEntities() async throws -> [FavPlayerEntity] {
        loadFavPlayers().map { FavPlayerEntity(id: $0.playerId, name: $0.name, position: $0.position ?? "") }
    }
    func defaultResult() async -> FavPlayerEntity? {
        try? await suggestedEntities().first
    }
}

@available(iOS 17.0, *)
struct SelectFavPlayerIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "최애선수 선택"
    static var description = IntentDescription("위젯에 표시할 최애선수를 선택하세요. (앱에서 최애선수를 먼저 등록해야 목록에 나타납니다.)")

    @Parameter(title: "선수")
    var player: FavPlayerEntity?

    init() {}
}

// MARK: - 데이터 모델 (/api/widget/player-card)

struct PCPlayer: Codable {
    var name: String
    var teamId: Int
    var number: Int
    var position: String
    var isPitcher: Bool
    var heroUrl: String?
    var photoUrl: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        teamId = (try? c.decodeIfPresent(Int.self, forKey: .teamId)) ?? 0
        number = (try? c.decodeIfPresent(Int.self, forKey: .number)) ?? 0
        position = (try? c.decodeIfPresent(String.self, forKey: .position)) ?? ""
        isPitcher = (try? c.decodeIfPresent(Bool.self, forKey: .isPitcher)) ?? false
        heroUrl = try? c.decodeIfPresent(String.self, forKey: .heroUrl)
        photoUrl = try? c.decodeIfPresent(String.self, forKey: .photoUrl)
    }
    init(name: String, teamId: Int, number: Int, position: String, isPitcher: Bool) {
        self.name = name; self.teamId = teamId; self.number = number
        self.position = position; self.isPitcher = isPitcher
        self.heroUrl = nil; self.photoUrl = nil
    }
    enum CodingKeys: String, CodingKey { case name, teamId, number, position, isPitcher, heroUrl, photoUrl }
}

struct PCHeadline: Codable {
    var label: String
    var value: String
    var direction: String
    init(label: String, value: String, direction: String) {
        self.label = label; self.value = value; self.direction = direction
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
        value = (try? c.decodeIfPresent(String.self, forKey: .value)) ?? ""
        direction = (try? c.decodeIfPresent(String.self, forKey: .direction)) ?? "stable"
    }
    enum CodingKeys: String, CodingKey { case label, value, direction }
}

struct PCToday: Codable {
    var show: Bool
    var isLive: Bool
    var opponentName: String?
    var line: String?
    var decision: String?
    var chips: [String]?
    init(show: Bool) { self.show = show; self.isLive = false }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        show = (try? c.decodeIfPresent(Bool.self, forKey: .show)) ?? false
        isLive = (try? c.decodeIfPresent(Bool.self, forKey: .isLive)) ?? false
        opponentName = try? c.decodeIfPresent(String.self, forKey: .opponentName)
        line = try? c.decodeIfPresent(String.self, forKey: .line)
        decision = try? c.decodeIfPresent(String.self, forKey: .decision)
        chips = try? c.decodeIfPresent([String].self, forKey: .chips)
    }
    enum CodingKeys: String, CodingKey { case show, isLive, opponentName, line, decision, chips }
}

struct PCRecent: Codable {
    var date: String
    var opponent: String
    var line: String
    var decision: String?
    init(date: String, opponent: String, line: String, decision: String?) {
        self.date = date; self.opponent = opponent; self.line = line; self.decision = decision
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = (try? c.decodeIfPresent(String.self, forKey: .date)) ?? ""
        opponent = (try? c.decodeIfPresent(String.self, forKey: .opponent)) ?? ""
        line = (try? c.decodeIfPresent(String.self, forKey: .line)) ?? ""
        decision = try? c.decodeIfPresent(String.self, forKey: .decision)
    }
    enum CodingKeys: String, CodingKey { case date, opponent, line, decision }
}

struct PlayerCardData: Codable {
    var player: PCPlayer?
    var headline: PCHeadline?
    var weekly: [Double]?
    var seasonLine: String?
    var titles: [String]?
    var today: PCToday?
    var recentGames: [PCRecent]?

    /// 미리보기/플레이스홀더용 더미(코랄 악센트, 실루엣). 안드 미리보기 스펙과 동일.
    static let preview = PlayerCardData(
        player: PCPlayer(name: "크보팬", teamId: 0, number: 1, position: "외야수", isPitcher: false),
        headline: PCHeadline(label: "최근 3경기 타율", value: ".327", direction: "improving"),
        weekly: [0.28, 0.31, 0.26, 0.34, 0.30, 0.29, 0.33, 0.312],
        seasonLine: "시즌 .312 · 15홈런 52타점",
        titles: ["타율 3위", "안타 5위", "득점 7위"],
        today: PCToday(show: false),
        recentGames: []
    )
    init(player: PCPlayer?, headline: PCHeadline?, weekly: [Double]?, seasonLine: String?,
         titles: [String]?, today: PCToday?, recentGames: [PCRecent]?) {
        self.player = player; self.headline = headline; self.weekly = weekly
        self.seasonLine = seasonLine; self.titles = titles; self.today = today
        self.recentGames = recentGames
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        player = try? c.decodeIfPresent(PCPlayer.self, forKey: .player)
        headline = try? c.decodeIfPresent(PCHeadline.self, forKey: .headline)
        weekly = try? c.decodeIfPresent([Double].self, forKey: .weekly)
        seasonLine = try? c.decodeIfPresent(String.self, forKey: .seasonLine)
        titles = try? c.decodeIfPresent([String].self, forKey: .titles)
        today = try? c.decodeIfPresent(PCToday.self, forKey: .today)
        recentGames = try? c.decodeIfPresent([PCRecent].self, forKey: .recentGames)
    }
    enum CodingKeys: String, CodingKey {
        case player, headline, weekly, seasonLine, titles, today, recentGames
    }
}

// MARK: - 악센트 컬러(팀 없으면 코랄) — 안드 team 폴백과 동일

@available(iOS 16.1, *)
private func pcAccent(_ teamId: Int) -> Color {
    (1...10).contains(teamId) ? teamColor(rankTeamCode(teamId)) : Color(hex: 0xE85050)
}

// MARK: - 이미지 다운로드/다운샘플 (익스텐션 메모리 예산 보호)

private func pcHeroFileURL(_ id: String) -> URL? {
    FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: kPCAppGroup)?
        .appendingPathComponent("player_card_\(id).img")
}

/// ImageIO 썸네일로 최대 변 maxPixel로 다운샘플(대형 원본 래스터화 OOM 방지). WebP 알파 보존.
private func pcDownsample(_ data: Data, maxPixel: CGFloat) -> UIImage? {
    let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let src = CGImageSourceCreateWithData(data as CFData, srcOpts) else { return nil }
    let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
    return UIImage(cgImage: cg)
}

private func pcCachedImage(_ id: String) -> UIImage? {
    guard let f = pcHeroFileURL(id), let data = try? Data(contentsOf: f) else { return nil }
    return pcDownsample(data, maxPixel: 320)
}

/// 히어로(우선)/헤드샷 이미지 로드 — 네트워크 실패 시 App Group 파일 캐시 폴백.
/// 반환 isCutout: heroUrl(webp 컷아웃)이면 true, photoUrl(jpg 헤드샷)이면 false.
@available(iOS 16.1, *)
private func pcLoadImage(id: String, player: PCPlayer) async -> (UIImage?, Bool) {
    var isCutout = true
    var raw = player.heroUrl ?? ""
    if raw.isEmpty || raw == "null" { raw = player.photoUrl ?? ""; isCutout = false }
    if raw.isEmpty || raw == "null" { return (pcCachedImage(id), isCutout) }
    if !raw.hasPrefix("http") { raw = kPCBase + raw }
    guard let url = URL(string: raw) else { return (pcCachedImage(id), isCutout) }
    var req = URLRequest(url: url)
    req.timeoutInterval = 8
    req.setValue("kbo-everyday-widget/1.0", forHTTPHeaderField: "User-Agent")
    do {
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            return (pcCachedImage(id), isCutout)
        }
        if let f = pcHeroFileURL(id) { try? data.write(to: f) }
        return (pcDownsample(data, maxPixel: 320), isCutout)
    } catch {
        return (pcCachedImage(id), isCutout)
    }
}

// MARK: - 데이터 fetch/캐시

private func pcCacheKey(_ id: String) -> String { "kbo_pc_\(id)" }

private func pcDecodeCache(_ id: String) -> PlayerCardData? {
    guard let ud = UserDefaults(suiteName: kPCAppGroup),
          let data = ud.data(forKey: pcCacheKey(id)),
          let parsed = try? JSONDecoder().decode(PlayerCardData.self, from: data),
          parsed.player != nil else { return nil }
    return parsed
}

@available(iOS 16.1, *)
private func pcFetchData(id: String) async -> PlayerCardData? {
    guard let url = URL(string: "\(kPCBase)/api/widget/player-card?id=\(id)") else {
        return pcDecodeCache(id)
    }
    var req = URLRequest(url: url)
    req.timeoutInterval = 8
    req.setValue("kbo-everyday-widget/1.0", forHTTPHeaderField: "User-Agent")
    do {
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let parsed = try? JSONDecoder().decode(PlayerCardData.self, from: data),
              parsed.player != nil else { return pcDecodeCache(id) }
        UserDefaults(suiteName: kPCAppGroup)?.set(data, forKey: pcCacheKey(id))
        return parsed
    } catch {
        return pcDecodeCache(id)
    }
}

// MARK: - Timeline

enum PCContent {
    case card(PlayerCardData)
    case empty(String)   // 안내 문구(선수 미선택/불러오는 중)
}

struct PlayerCardEntry: TimelineEntry {
    let date: Date
    let content: PCContent
    let image: UIImage?
    let isCutout: Bool
}

@available(iOS 17.0, *)
struct PlayerCardProvider: AppIntentTimelineProvider {
    typealias Entry = PlayerCardEntry
    typealias Intent = SelectFavPlayerIntent

    func placeholder(in context: Context) -> PlayerCardEntry {
        PlayerCardEntry(date: Date(), content: .card(.preview), image: nil, isCutout: true)
    }

    func snapshot(for configuration: SelectFavPlayerIntent, in context: Context) async -> PlayerCardEntry {
        if context.isPreview {
            return PlayerCardEntry(date: Date(), content: .card(.preview), image: nil, isCutout: true)
        }
        return await buildEntry(for: configuration)
    }

    func timeline(for configuration: SelectFavPlayerIntent, in context: Context) async -> Timeline<PlayerCardEntry> {
        let entry = await buildEntry(for: configuration)
        let next = Date().addingTimeInterval(30 * 60)
        return Timeline(entries: [entry], policy: .after(next))
    }

    private func buildEntry(for configuration: SelectFavPlayerIntent) async -> PlayerCardEntry {
        // 선택된 선수 → 없으면 최애 목록 첫 선수 → 그래도 없으면 안내.
        let id = configuration.player?.id ?? loadFavPlayers().first?.playerId
        guard let id, !id.isEmpty else {
            return PlayerCardEntry(
                date: Date(),
                content: .empty("위젯을 길게 눌러 최애선수를 선택하세요.\n(앱에서 최애선수를 먼저 등록해주세요)"),
                image: nil, isCutout: true)
        }
        guard let data = await pcFetchData(id: id), let player = data.player else {
            return PlayerCardEntry(date: Date(), content: .empty("선수 정보를 불러오는 중이에요"),
                                   image: nil, isCutout: true)
        }
        let (img, cutout) = await pcLoadImage(id: id, player: player)
        return PlayerCardEntry(date: Date(), content: .card(data), image: img, isCutout: cutout)
    }
}

// MARK: - 색 토큰 (globals.css .dark)

@available(iOS 16.1, *)
private enum PCColor {
    static let card = Color(hex: 0x141416)
    static let text = Color(hex: 0xF5F5F7)
    static let tertiary = Color(hex: 0x8E8E93)
    static let up = Color(hex: 0x34C759)
    static let down = Color(hex: 0xFF453A)
    static let live = Color(hex: 0xF87171)
    static let border = Color.white.opacity(0.08)
}

// MARK: - 스파크라인

@available(iOS 16.1, *)
struct Sparkline: Shape {
    let values: [Double]
    let extraPad: Double   // 투수 ERA는 0.3, 타율은 0.01
    func path(in rect: CGRect) -> Path {
        var p = Path()
        guard values.count >= 2 else { return p }
        let vmin0 = values.min() ?? 0
        let vmax0 = values.max() ?? 1
        let pad = max((vmax0 - vmin0) * 0.15, extraPad)
        let vmin = vmin0 - pad
        let vmax = vmax0 + pad
        let range = max(vmax - vmin, 0.0001)
        for (i, v) in values.enumerated() {
            let x = rect.minX + rect.width * CGFloat(i) / CGFloat(values.count - 1)
            let y = rect.maxY - rect.height * CGFloat((v - vmin) / range)
            if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
        }
        return p
    }
}

// MARK: - 카드 뷰

@available(iOS 17.0, *)
struct KBOPlayerCardEntryView: View {
    @Environment(\.widgetFamily) var family
    let entry: PlayerCardEntry

    var body: some View {
        Group {
            switch entry.content {
            case .card(let data):
                PlayerCard(data: data, image: entry.image, isCutout: entry.isCutout,
                           isLarge: family == .systemLarge)
            case .empty(let msg):
                PlayerCardEmpty(message: msg)
            }
        }
        // '새로고침만' 모드(iOS17+)면 콘텐츠를 새로고침 인텐트로 감싸다(config 선수선택 intent와 별개). 배경은 바깥 유지.
        .widgetTapRefreshWrap()
        .widgetBG { PCColor.card }
    }
}

@available(iOS 17.0, *)
struct PlayerCardEmpty: View {
    let message: String
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.system(size: 26))
                .foregroundStyle(.white.opacity(0.4))
            Text(message)
                .font(notoKR(12, .medium))
                .multilineTextAlignment(.center)
                .foregroundStyle(.white.opacity(0.65))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(16)
    }
}

@available(iOS 17.0, *)
struct PlayerCard: View {
    let data: PlayerCardData
    let image: UIImage?
    let isCutout: Bool
    let isLarge: Bool

    private var player: PCPlayer { data.player ?? PCPlayer(name: "", teamId: 0, number: 0, position: "", isPitcher: false) }
    private var accent: Color { pcAccent(player.teamId) }
    private var panelW: CGFloat { isLarge ? 140 : 118 }
    private var showToday: Bool { data.today?.show == true }

    var body: some View {
        HStack(spacing: 0) {
            heroPanel
                .frame(width: panelW)
                .frame(maxHeight: .infinity)
                .clipped()

            VStack(alignment: .leading, spacing: isLarge ? 8 : 4) {
                topRow
                Spacer(minLength: 2)
                middle
                // Large는 라이브(오늘 경기) 중에도 최근 경기로 세로 공간을 채운다
                // (2026-07-08 QA: 라이브 시 Large 카드 중앙이 비어 보임)
                if isLarge, let recent = data.recentGames, !recent.isEmpty {
                    Spacer(minLength: 2)
                    recentSection(recent)
                }
                Spacer(minLength: 2)
                badges
            }
            .padding(.leading, 10)
            .padding(.trailing, 14)
            .padding(.vertical, isLarge ? 14 : 11)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    // ── 히어로 패널 (팀컬러 그라데이션 + 컷아웃 하단 정렬, 비율 유지)
    // 실기기에서 aspectRatio(.fit)+무한 frame 조합이 사진을 패널 밖(위젯 왼쪽 바깥)으로
    // 밀어내는 렌더 이탈 확인(2026-07-08 QA) → 안드 renderCard처럼 min(폭비,높이비)
    // 균일 스케일을 직접 계산해 패널 하단 중앙에 고정한다.
    private var heroPanel: some View {
        GeometryReader { geo in
            let pw = geo.size.width
            let ph = geo.size.height
            ZStack {
                LinearGradient(colors: [accent.opacity(0.0), accent.opacity(0.30)],
                               startPoint: .top, endPoint: .bottom)
                if let image, image.size.width > 0, image.size.height > 0 {
                    let availH = max(ph - 10, 1)   // 상단 여백 10pt
                    let scale = min(pw / image.size.width, availH / image.size.height)
                    let w = image.size.width * scale
                    let h = image.size.height * scale
                    Image(uiImage: image)
                        .resizable()
                        .fullColorInAccentedWidget()
                        .frame(width: w, height: h)
                        .clipShape(isCutout ? AnyShape(Rectangle()) : AnyShape(Circle()))
                        .position(x: pw / 2, y: ph - h / 2)   // 하단 중앙 고정
                } else {
                    // 익명 실루엣(미리보기/이미지 없음)
                    Image(systemName: "person.fill")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .foregroundStyle(.white.opacity(0.16))
                        .frame(width: max(pw - 48, 10))
                        .position(x: pw / 2, y: ph * 0.64)
                }
            }
            .frame(width: pw, height: ph)
            .clipped()
        }
    }

    // ── 이름/등번호 + 헤드라인
    private var topRow: some View {
        HStack(alignment: .top, spacing: 6) {
            // 팀 로고 뱃지 — 홈 화면 단독 배치라 어느 팀 선수인지 identity 필요(2026-07-08 하린아빠)
            if (1...10).contains(player.teamId) {
                ZStack {
                    Circle().fill(.white)
                    TeamLogo(code: rankTeamCode(player.teamId), size: 17)
                }
                .frame(width: 25, height: 25)
                .padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: 2) {
                mixedScriptText(player.name, 16, .bold)
                    .foregroundStyle(PCColor.text)
                    .lineLimit(1).minimumScaleFactor(0.7)
                mixedScriptText(numberPosition, 12, .semibold)
                    .foregroundStyle(PCColor.tertiary)
                    .lineLimit(1).minimumScaleFactor(0.8)
            }
            Spacer(minLength: 4)
            if let h = data.headline {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(h.label)
                        .font(notoKR(11, .medium))
                        .foregroundStyle(PCColor.tertiary)
                        .lineLimit(1).minimumScaleFactor(0.8)
                    HStack(spacing: 3) {
                        Text(h.value)
                            .font(montserrat(22, .black)).monospacedDigit()
                            .foregroundStyle(PCColor.text)
                        arrow(h.direction)
                    }
                }
                .fixedSize()
            }
        }
    }

    private var numberPosition: String {
        let n = player.number > 0 ? "#\(player.number) " : ""
        return n + player.position
    }

    @ViewBuilder
    private func arrow(_ direction: String) -> some View {
        if direction == "improving" {
            Image(systemName: "arrowtriangle.up.fill")
                .font(.system(size: 10)).foregroundStyle(PCColor.up)
        } else if direction == "declining" {
            Image(systemName: "arrowtriangle.down.fill")
                .font(.system(size: 10)).foregroundStyle(PCColor.down)
        }
    }

    // ── 가운데: 오늘 경기 있으면 활약 섹션, 없으면 주간 스파크라인 + 시즌 라인
    @ViewBuilder
    private var middle: some View {
        if showToday, let today = data.today {
            todaySection(today)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                if let weekly = data.weekly, weekly.count >= 2 {
                    Text("시즌 주간 페이스 · \(player.isPitcher ? "ERA" : "타율")")
                        .font(notoKR(10, .medium))
                        .foregroundStyle(PCColor.tertiary)
                    Sparkline(values: weekly, extraPad: player.isPitcher ? 0.3 : 0.01)
                        .stroke(accent, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .frame(height: isLarge ? 34 : 24)
                }
                if let s = data.seasonLine, !s.isEmpty, s != "null" {
                    mixedScriptText(s, 10, .medium)
                        .foregroundStyle(PCColor.tertiary)
                        .lineLimit(1).minimumScaleFactor(0.8)
                } else if data.headline == nil {
                    Text("2026 시즌 기록 준비 중")
                        .font(notoKR(12, .medium))
                        .foregroundStyle(PCColor.tertiary)
                }
            }
        }
    }

    // ── 오늘 경기 활약
    private func todaySection(_ today: PCToday) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text("오늘 경기").font(notoKR(10, .bold)).foregroundStyle(PCColor.tertiary)
                if today.isLive {
                    Text("LIVE").font(montserrat(9, .bold))
                        .foregroundStyle(PCColor.live)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Capsule().fill(PCColor.live.opacity(0.2)))
                }
                if let opp = today.opponentName, !opp.isEmpty, opp != "null" {
                    mixedScriptText("vs \(opp)", 10, .medium).foregroundStyle(PCColor.tertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 6) {
                if let line = today.line, !line.isEmpty {
                    // 활약 줄은 절대 말줄임하지 않는다 — 칩이 밀려나는 쪽 (안드 renderCard 동일, 2026-07-08 QA "2타수 1…")
                    mixedScriptText(line, 15, .bold).foregroundStyle(PCColor.text)
                        .lineLimit(1).fixedSize()
                        .layoutPriority(1)
                }
                if let dec = today.decision, !dec.isEmpty, dec != "null" {
                    chip(dec, filled: true)
                }
                let chipList = (today.chips ?? []).prefix(3).filter { !$0.isEmpty }
                if !chipList.isEmpty {
                    ViewThatFits(in: .horizontal) {
                        ForEach(Array(stride(from: chipList.count, through: 0, by: -1)), id: \.self) { n in
                            HStack(spacing: 6) {
                                ForEach(Array(chipList.prefix(n).enumerated()), id: \.offset) { _, c in
                                    chip(c, filled: false)
                                }
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    // ── 최근 경기 (Large + 오늘 경기 없을 때)
    private func recentSection(_ recent: [PCRecent]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("최근 경기").font(notoKR(10, .bold)).foregroundStyle(PCColor.tertiary)
            ForEach(Array(recent.prefix(3).enumerated()), id: \.offset) { _, g in
                HStack(spacing: 8) {
                    mixedScriptText("\(g.date) \(g.opponent)", 10, .medium)
                        .foregroundStyle(PCColor.tertiary)
                        .frame(width: 92, alignment: .leading)
                        .lineLimit(1).minimumScaleFactor(0.8)
                    mixedScriptText(g.line, 12, .bold).foregroundStyle(PCColor.text)
                        .lineLimit(1).minimumScaleFactor(0.8)
                    if let dec = g.decision, !dec.isEmpty, dec != "null" {
                        chip(dec, filled: false)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    // ── 부문 타이틀 뱃지 (한 줄 — 안 들어가면 개수를 줄여 중간 잘림 방지, 2026-07-08 QA)
    @ViewBuilder
    private var badges: some View {
        if let titles = data.titles, !titles.isEmpty {
            ViewThatFits(in: .horizontal) {
                ForEach(Array(stride(from: titles.count, through: 1, by: -1)), id: \.self) { n in
                    badgeRow(Array(titles.prefix(n)))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func badgeRow(_ titles: [String]) -> some View {
        HStack(spacing: 6) {
            ForEach(Array(titles.enumerated()), id: \.offset) { i, t in
                let label = (i == 0 ? "🏆 " : "") + t
                Text(label)
                    .font(notoKR(11, .semibold))
                    .foregroundStyle(accent)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(Capsule().fill(accent.opacity(0.12)))
                    .lineLimit(1).fixedSize()
            }
        }
    }

    // 칩/뱃지 pill — filled=결정(팀컬러 배경, 흰 글씨) / else 팀컬러 틴트
    private func chip(_ text: String, filled: Bool) -> some View {
        mixedScriptText(text, 11, .semibold)
            .foregroundStyle(filled ? Color.white : accent)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(filled ? accent : accent.opacity(0.12)))
            .lineLimit(1).fixedSize()
    }
}

// MARK: - Widget 정의

@available(iOS 17.0, *)
struct KBOPlayerCardWidget: Widget {
    let kind = "KBOPlayerCardWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind,
                               intent: SelectFavPlayerIntent.self,
                               provider: PlayerCardProvider()) { entry in
            KBOPlayerCardEntryView(entry: entry)
        }
        .configurationDisplayName("최애선수 카드")
        .description("최애선수의 스탯과 오늘 경기 활약을 홈 화면에서 확인하세요.")
        // Large는 세로 여백 과다로 미제공 (iOS 위젯 높이는 고정 규격이라 축소 불가 — 2026-07-08 하린아빠 QA)
        .supportedFamilies([.systemMedium])
        .contentMarginsDisabled()
    }
}
