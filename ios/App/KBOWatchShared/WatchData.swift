//
//  WatchData.swift
//  워치 앱·컴플리케이션 공유 데이터 레이어 (두 watch 타깃에 모두 멤버십).
//
//  서버 무변경 원칙: 홈 위젯과 동일하게 keubo.fan 공개 API(/api/games·/api/standings)를
//  직접 fetch하고 App Group에 캐시한다(오프라인/실패 시 폴백). 최애팀 코드는 iPhone 앱이
//  WCSession applicationContext로 보내준 값을 워치 앱이 App Group에 기록한 것을 읽는다.
//

import Foundation
import SwiftUI

// MARK: - 팀 메타 (폰 위젯 rankTeamCode/rankHighlightHex와 동일 매핑 — 워치 타깃은
// LiveActivity 익스텐션 소스를 공유하지 않아 자체 보유)

enum WatchTeam {
    static func code(fromId id: Int) -> String {
        switch id {
        case 1: return "LG"; case 2: return "OB"; case 3: return "KT"
        case 4: return "SK"; case 5: return "NC"; case 6: return "HT"
        case 7: return "LT"; case 8: return "SS"; case 9: return "HH"
        case 10: return "WO"
        default: return ""
        }
    }

    static func id(fromCode code: String) -> Int {
        switch code.uppercased() {
        case "LG": return 1; case "OB": return 2; case "KT": return 3
        case "SK": return 4; case "NC": return 5; case "HT": return 6
        case "LT": return 7; case "SS": return 8; case "HH": return 9
        case "WO": return 10
        default: return 0
        }
    }

    static func short(_ code: String) -> String {
        switch code.uppercased() {
        case "LG": return "LG"; case "OB": return "두산"; case "KT": return "KT"
        case "SK": return "SSG"; case "NC": return "NC"; case "HT": return "KIA"
        case "LT": return "롯데"; case "SS": return "삼성"; case "HH": return "한화"
        case "WO": return "키움"
        default: return code
        }
    }

    /// /api/team-schedule는 팀 slug를 받는다 (TEAMS.slug와 동일 매핑).
    static func slug(fromId id: Int) -> String {
        switch id {
        case 1: return "lg"; case 2: return "doosan"; case 3: return "kt"
        case 4: return "ssg"; case 5: return "nc"; case 6: return "kia"
        case 7: return "lotte"; case 8: return "samsung"; case 9: return "hanwha"
        case 10: return "kiwoom"
        default: return ""
        }
    }

    /// 팀 로고 에셋 이름 — 갤워치 타일과 동일한 폰앱 teamlogo_* 96px(흰 원형 칩) 사본.
    /// 워치 앱 타깃 Assets.xcassets에만 존재. 미지의 코드(더미 등)는 nil → 텍스트만 렌더.
    static func logoAsset(_ code: String) -> String? {
        id(fromCode: code) == 0 ? nil : "TeamLogo_\(code.uppercased())"
    }

    /// 다크 서페이스용 팀 하이라이트 RGB — 갤워치 WearTeam.highlightColor·폰 위젯
    /// TeamRankWidget.HL_BY_ID와 동일값(임의 변경 금지).
    private static func highlightRGB(_ code: String) -> UInt32? {
        switch code.uppercased() {
        case "LG": return 0xC60C30; case "OB": return 0x9BA8D4; case "KT": return 0xE85050
        case "SK": return 0xCE0E2D; case "NC": return 0x315288; case "HT": return 0xEA0029
        case "LT": return 0x6BC4E8; case "SS": return 0x074CA1; case "HH": return 0xFF6600
        case "WO": return 0xC97088
        default: return nil
        }
    }

    static func highlightColor(_ code: String) -> Color {
        color(fromRGB: highlightRGB(code) ?? 0xF5F5F7)
    }

    /// 최애팀 컬러 은은한 카드 틴트 — highlightColor를 다크 베이스에 20% 블렌딩
    /// (갤워치 WearTeam.cardTint와 동일 공식: 채널 × 0.20 + 0x14). 미지의 팀은 기존 중립 카드색.
    static func cardTint(_ code: String) -> Color {
        guard let rgb = highlightRGB(code) else { return Color.white.opacity(0.12) }
        func ch(_ shift: UInt32) -> Double {
            min(255, Double((rgb >> shift) & 0xFF) * 0.20 + 20) / 255
        }
        return Color(red: ch(16), green: ch(8), blue: ch(0))
    }

    private static func color(fromRGB rgb: UInt32) -> Color {
        Color(red: Double((rgb >> 16) & 0xFF) / 255,
              green: Double((rgb >> 8) & 0xFF) / 255,
              blue: Double(rgb & 0xFF) / 255)
    }
}

// MARK: - App Group 스토어 (워치 사이드 — 폰과는 별개 컨테이너, 워치 앱 ↔ 워치 위젯 공유)

enum WatchStore {
    static let appGroupId = "group.fan.keubo.app"
    private static let kMyTeam = "watch_my_team"
    private static let kSnapshotCache = "watch_snapshot_cache"

    static func loadMyTeam() -> String {
        UserDefaults(suiteName: appGroupId)?.string(forKey: kMyTeam) ?? ""
    }

    static func saveMyTeam(_ code: String) {
        UserDefaults(suiteName: appGroupId)?.set(code, forKey: kMyTeam)
    }

    static func loadCachedSnapshot() -> WatchSnapshot? {
        guard let data = UserDefaults(suiteName: appGroupId)?.data(forKey: kSnapshotCache) else { return nil }
        return try? JSONDecoder().decode(WatchSnapshot.self, from: data)
    }

    static func saveCachedSnapshot(_ snap: WatchSnapshot) {
        guard let data = try? JSONEncoder().encode(snap) else { return }
        UserDefaults(suiteName: appGroupId)?.set(data, forKey: kSnapshotCache)
    }
}

// MARK: - 서버 응답 모델 (null/누락 방어 커스텀 디코딩 — 폰 RankRow 패턴)

// 잔루 상태(1·2·3루 점유) — /api/games `runnersOn`. 라이브 카드 다이아몬드 표시용.
struct WatchBases: Codable {
    var first: Bool
    var second: Bool
    var third: Bool
    var any: Bool { first || second || third }

    enum CodingKeys: String, CodingKey { case first, second, third }
    init(first: Bool, second: Bool, third: Bool) {
        self.first = first; self.second = second; self.third = third
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        first = (try? c.decodeIfPresent(Bool.self, forKey: .first)) ?? false
        second = (try? c.decodeIfPresent(Bool.self, forKey: .second)) ?? false
        third = (try? c.decodeIfPresent(Bool.self, forKey: .third)) ?? false
    }
}

struct WatchGame: Codable {
    var gameId: String
    var time: String
    var stadium: String
    var awayTeamId: Int
    var homeTeamId: Int
    var awayScore: Int?
    var homeScore: Int?
    var inning: Int
    var isTop: Bool
    var status: String   // "scheduled" | "live" | "final" | "cancelled"
    var outs: Int
    var runnersOn: WatchBases?
    var awayStarterName: String
    var homeStarterName: String
    var currentPitcher: String
    var currentBatter: String

    enum CodingKeys: String, CodingKey {
        case gameId, time, stadium, awayTeamId, homeTeamId, awayScore, homeScore, inning, isTop, status, outs, runnersOn
        case awayStarterName, homeStarterName, currentPitcher, currentBatter
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        gameId = (try? c.decodeIfPresent(String.self, forKey: .gameId)) ?? ""
        time = (try? c.decodeIfPresent(String.self, forKey: .time)) ?? ""
        stadium = (try? c.decodeIfPresent(String.self, forKey: .stadium)) ?? ""
        awayTeamId = (try? c.decodeIfPresent(Int.self, forKey: .awayTeamId)) ?? 0
        homeTeamId = (try? c.decodeIfPresent(Int.self, forKey: .homeTeamId)) ?? 0
        awayScore = try? c.decodeIfPresent(Int.self, forKey: .awayScore)
        homeScore = try? c.decodeIfPresent(Int.self, forKey: .homeScore)
        inning = (try? c.decodeIfPresent(Int.self, forKey: .inning)) ?? 0
        isTop = (try? c.decodeIfPresent(Bool.self, forKey: .isTop)) ?? true
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "scheduled"
        outs = (try? c.decodeIfPresent(Int.self, forKey: .outs)) ?? 0
        runnersOn = try? c.decodeIfPresent(WatchBases.self, forKey: .runnersOn)
        awayStarterName = (try? c.decodeIfPresent(String.self, forKey: .awayStarterName)) ?? ""
        homeStarterName = (try? c.decodeIfPresent(String.self, forKey: .homeStarterName)) ?? ""
        currentPitcher = (try? c.decodeIfPresent(String.self, forKey: .currentPitcher)) ?? ""
        currentBatter = (try? c.decodeIfPresent(String.self, forKey: .currentBatter)) ?? ""
    }
}

struct WatchGamesResponse: Codable { var games: [WatchGame] }

struct WatchRankRow: Codable {
    var teamId: Int
    var ranking: Int
    var gamesBehind: Double

    enum CodingKeys: String, CodingKey { case teamId, ranking, gamesBehind }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        teamId = (try? c.decodeIfPresent(Int.self, forKey: .teamId)) ?? 0
        ranking = (try? c.decodeIfPresent(Int.self, forKey: .ranking)) ?? 0
        gamesBehind = (try? c.decodeIfPresent(Double.self, forKey: .gamesBehind)) ?? 0
    }
}

struct WatchStandingsResponse: Codable { var standings: [WatchRankRow] }

// /api/team-schedule 응답 — 오늘 경기 없을 때 "다음 예정 경기" 폴백에만 사용(디코드 전용).
struct WatchScheduleDay: Decodable {
    var date: String     // "YYYYMMDD"
    var status: String   // "scheduled" | "live" | "final" | "cancelled"
    var home: Bool       // 최애팀이 홈이면 true
    var time: String     // "18:30"
    var opponentId: Int
    var stadium: String  // 구장 (미제공 시 "")

    enum CodingKeys: String, CodingKey { case date, status, home, time, opponent, stadium }
    enum OppKeys: String, CodingKey { case id }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = (try? c.decodeIfPresent(String.self, forKey: .date)) ?? ""
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "scheduled"
        home = (try? c.decodeIfPresent(Bool.self, forKey: .home)) ?? false
        time = (try? c.decodeIfPresent(String.self, forKey: .time)) ?? ""
        stadium = (try? c.decodeIfPresent(String.self, forKey: .stadium)) ?? ""
        if let opp = try? c.nestedContainer(keyedBy: OppKeys.self, forKey: .opponent) {
            opponentId = (try? opp.decodeIfPresent(Int.self, forKey: .id)) ?? 0
        } else {
            opponentId = 0
        }
    }
}

struct WatchScheduleResponse: Decodable { var days: [WatchScheduleDay] }

// MARK: - 렌더 스냅샷 (컴플리케이션·워치 앱이 그리는 최종 형태)

struct WatchSnapshot: Codable {
    var kind: String        // "live" | "scheduled" | "final" | "cancelled" | "noGame" | "noTeam"
    var myTeamCode: String
    var awayCode: String
    var homeCode: String
    var awayScore: Int
    var homeScore: Int
    var line: String        // 상태 한 줄 ("LIVE 6회말 · 2사" / "오늘 18:30 · 선발 곽빈" / "경기 종료 · 승")
    var rankLine: String    // "2위 · 1위와 1.5경기차" (순위 미확보 시 "")
    var updatedAt: Date
    var startAt: Date?      // 예정 경기 시작 시각(KST) — 원형 컴플리케이션 카운트다운용. scheduled 외엔 nil
    var bases: WatchBases?  // 잔루(1·2·3루) — 라이브 다이아몬드 표시용. live 외엔 nil
    // 리치 화면(하린아빠 승인 목업) — 전부 optional: 구버전 캐시 JSON 디코드 호환(keyNotFound 방지)
    var venue: String?      // 구장("잠실") — 카드 상단
    var outs: Int?          // 아웃카운트 — live 하단 도트 행
    var pitcher: String?    // 현재 투수 — live
    var batter: String?     // 현재 타자 — live
    var lastPlay: String?   // 최근 플레이 한 줄(문자중계) — live
    var starters: String?   // "선발 곡빈 vs 원태인" — scheduled
    var nextLine: String?   // 다음 경기 "7/18(금) 18:30" — final 하단 컴팩트 카드
    var nextAwayCode: String?
    var nextHomeCode: String?
    var nextVenue: String?

    var isLive: Bool { kind == "live" }
    var hasScore: Bool { kind == "live" || kind == "final" }

    static func noTeam() -> WatchSnapshot {
        WatchSnapshot(kind: "noTeam", myTeamCode: "", awayCode: "", homeCode: "",
                      awayScore: 0, homeScore: 0,
                      line: "크보팬 앱에서 최애팀을 선택하세요", rankLine: "", updatedAt: Date(),
                      startAt: nil, bases: nil)
    }

    /// 리치 필드는 기본 nil — 기존 생성자 호출부(컴플리케이션 등) 무변경 유지.
    init(kind: String, myTeamCode: String, awayCode: String, homeCode: String,
         awayScore: Int, homeScore: Int, line: String, rankLine: String, updatedAt: Date,
         startAt: Date?, bases: WatchBases?,
         venue: String? = nil, outs: Int? = nil, pitcher: String? = nil, batter: String? = nil,
         lastPlay: String? = nil, starters: String? = nil,
         nextLine: String? = nil, nextAwayCode: String? = nil, nextHomeCode: String? = nil,
         nextVenue: String? = nil) {
        self.kind = kind
        self.myTeamCode = myTeamCode
        self.awayCode = awayCode
        self.homeCode = homeCode
        self.awayScore = awayScore
        self.homeScore = homeScore
        self.line = line
        self.rankLine = rankLine
        self.updatedAt = updatedAt
        self.startAt = startAt
        self.bases = bases
        self.venue = venue
        self.outs = outs
        self.pitcher = pitcher
        self.batter = batter
        self.lastPlay = lastPlay
        self.starters = starters
        self.nextLine = nextLine
        self.nextAwayCode = nextAwayCode
        self.nextHomeCode = nextHomeCode
        self.nextVenue = nextVenue
    }

    /// 위젯 갤러리/스냅샷용 익명 더미(실팀 노출 금지 — 폰 위젯 미리보기 폴리시와 동일).
    static func previewDummy() -> WatchSnapshot {
        WatchSnapshot(kind: "live", myTeamCode: "", awayCode: "수달스", homeCode: "돌고래스",
                      awayScore: 3, homeScore: 5,
                      line: "LIVE 7회말 · 1사", rankLine: "2위 · 1위와 1.5경기차",
                      updatedAt: Date(timeIntervalSince1970: 1_783_600_000), startAt: nil,
                      bases: WatchBases(first: true, second: false, third: true))
    }
}

// MARK: - Fetch (games + standings → WatchSnapshot 합성)

enum WatchFetcher {
    private static let base = "https://keubo.fan"

    /// 홈 팀카드/홈위젯과 동일한 06시 롤오버: 06:00 KST 전엔 전날 경기를 보여준다.
    static func effectiveDateString(now: Date = Date()) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Seoul") ?? .current
        var target = now
        if cal.component(.hour, from: now) < 6 {
            target = cal.date(byAdding: .day, value: -1, to: now) ?? now
        }
        let f = DateFormatter()
        f.timeZone = cal.timeZone
        f.dateFormat = "yyyyMMdd"
        return f.string(from: target)
    }

    private static func get(_ path: String, completion: @escaping (Data?) -> Void) {
        guard let url = URL(string: base + path) else { completion(nil); return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        req.setValue("kbo-everyday-watch/1.0", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            guard let data, let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                completion(nil); return
            }
            completion(data)
        }.resume()
    }

    /// 최애팀 기준 스냅샷 합성. 실패 시 캐시 폴백, 캐시도 없으면 순위 없는 최소 스냅샷.
    static func fetch(completion: @escaping (WatchSnapshot) -> Void) {
        let myCode = WatchStore.loadMyTeam()
        guard !myCode.isEmpty else { completion(.noTeam()); return }
        let myId = WatchTeam.id(fromCode: myCode)

        let group = DispatchGroup()
        var games: [WatchGame] = []
        var gamesOk = false
        var rankRow: WatchRankRow?

        group.enter()
        get("/api/games?date=\(effectiveDateString())") { data in
            if let data, let parsed = try? JSONDecoder().decode(WatchGamesResponse.self, from: data) {
                games = parsed.games
                gamesOk = true
            }
            group.leave()
        }

        group.enter()
        get("/api/standings") { data in
            if let data, let parsed = try? JSONDecoder().decode(WatchStandingsResponse.self, from: data) {
                // ranking 0(미제공)이면 배열 순서 폴백 — 폰 resolveRows와 동일
                for (i, row) in parsed.standings.enumerated() where row.teamId == myId {
                    var r = row
                    if r.ranking <= 0 { r.ranking = i + 1 }
                    rankRow = r
                }
            }
            group.leave()
        }

        group.notify(queue: .global()) {
            // 경기 fetch 실패 시 캐시 폴백(다른 팀 캐시는 무시) — stale이어도 빈 화면보단 낫다.
            if !gamesOk, let cached = WatchStore.loadCachedSnapshot(), cached.myTeamCode == myCode {
                completion(cached); return
            }
            var snap = compose(myCode: myCode, myId: myId, games: games, rankRow: rankRow)
            // 오늘 최애팀 경기가 없으면 "오늘 경기 없음" 대신 다음 예정 경기를 보여준다
            // (올스타 브레이크·팀 휴식일 대응). 예정 경기도 없으면 compose의 noGame 유지.
            if snap.kind == "noGame" {
                fetchNextGameDay(myId: myId) { day in
                    let final = day.map { nextSnapshot(myCode: myCode, day: $0, rank: snap.rankLine) } ?? snap
                    WatchStore.saveCachedSnapshot(final)
                    completion(final)
                }
                return
            }
            // 라이브: 문자중계 최근 플레이 한 줄(실패해도 카드 무영향 — nil 유지).
            if snap.kind == "live",
               let gid = games.first(where: { ($0.awayTeamId == myId || $0.homeTeamId == myId) && $0.status == "live" })?.gameId,
               !gid.isEmpty {
                fetchLastPlay(gameId: gid) { play in
                    snap.lastPlay = play
                    if gamesOk { WatchStore.saveCachedSnapshot(snap) }
                    completion(snap)
                }
                return
            }
            // 종료: 하단 "다음 경기" 컴팩트 카드용 정보 부착(실패 시 본 카드만).
            if snap.kind == "final" {
                fetchNextGameDay(myId: myId) { day in
                    if let day {
                        let oppCode = WatchTeam.code(fromId: day.opponentId)
                        snap.nextAwayCode = day.home ? oppCode : myCode
                        snap.nextHomeCode = day.home ? myCode : oppCode
                        snap.nextLine = scheduleLine(dateYMD: day.date, time: day.time)
                        snap.nextVenue = day.stadium.isEmpty ? nil : day.stadium
                    }
                    if gamesOk { WatchStore.saveCachedSnapshot(snap) }
                    completion(snap)
                }
                return
            }
            if gamesOk { WatchStore.saveCachedSnapshot(snap) }
            completion(snap)
        }
    }

    // MARK: - 문자중계 최근 플레이 (라이브 카드 한 줄 — 서버 warmup latestRelayLine과 동일 규칙)

    struct WatchRelayPlay: Decodable { var batterName: String?; var result: String? }
    struct WatchRelayInning: Decodable { var plays: [WatchRelayPlay]? }
    struct WatchRelayResponse: Decodable { var innings: [WatchRelayInning]? }

    /// 마지막 non-empty 이닝의 마지막 play → "타자 결과"(40자 캡). 실패/빈 응답은 nil.
    static func fetchLastPlay(gameId: String, completion: @escaping (String?) -> Void) {
        get("/api/game-relay?gameId=\(gameId)") { data in
            guard let data,
                  let parsed = try? JSONDecoder().decode(WatchRelayResponse.self, from: data),
                  let innings = parsed.innings else { completion(nil); return }
            var last: WatchRelayPlay?
            for inn in innings where (inn.plays?.isEmpty == false) {
                last = inn.plays?.last
            }
            guard let p = last, let name = p.batterName, let result = p.result,
                  !name.isEmpty, !result.isEmpty else { completion(nil); return }
            let line = "\(name) \(result)"
            completion(line.count > 40 ? String(line.prefix(39)) + "…" : line)
        }
    }

    static func rankLine(_ row: WatchRankRow?) -> String {
        guard let row, row.ranking > 0 else { return "" }
        let gb = row.gamesBehind
        guard gb > 0 else { return "\(row.ranking)위" }
        let gbText = gb == gb.rounded(.down) ? String(Int(gb)) : String(format: "%.1f", gb)
        return "\(row.ranking)위 · 1위와 \(gbText)경기차"
    }

    /// 더블헤더 대비 선택 우선순위: live > scheduled(첫 경기) > final(마지막) > cancelled.
    static func pickGame(_ games: [WatchGame], myId: Int) -> WatchGame? {
        let mine = games.filter { $0.awayTeamId == myId || $0.homeTeamId == myId }
        if let live = mine.first(where: { $0.status == "live" }) { return live }
        if let sched = mine.first(where: { $0.status == "scheduled" }) { return sched }
        if let fin = mine.last(where: { $0.status == "final" }) { return fin }
        return mine.last
    }

    static func compose(myCode: String, myId: Int, games: [WatchGame], rankRow: WatchRankRow?) -> WatchSnapshot {
        let rank = rankLine(rankRow)
        guard let g = pickGame(games, myId: myId) else {
            return WatchSnapshot(kind: "noGame", myTeamCode: myCode, awayCode: "", homeCode: "",
                                 awayScore: 0, homeScore: 0,
                                 line: "오늘 경기 없음", rankLine: rank, updatedAt: Date(),
                                 startAt: nil, bases: nil)
        }
        let awayCode = WatchTeam.code(fromId: g.awayTeamId)
        let homeCode = WatchTeam.code(fromId: g.homeTeamId)
        let myIsAway = g.awayTeamId == myId
        let aScore = g.awayScore ?? 0
        let hScore = g.homeScore ?? 0

        let line: String
        switch g.status {
        case "live":
            let half = g.isTop ? "초" : "말"
            line = "LIVE \(g.inning)회\(half) · \(g.outs)사"
        case "final":
            let myScore = myIsAway ? aScore : hScore
            let oppScore = myIsAway ? hScore : aScore
            let result = myScore > oppScore ? "승" : (myScore < oppScore ? "패" : "무")
            line = "경기 종료 · \(result)"
        case "cancelled":
            line = "경기 취소"
        default:
            line = "오늘 \(g.time)"
        }

        // 오늘 예정 경기만 시작 시각 부착(원형 카운트다운용). 라이브/종료/취소는 nil.
        let startAt = g.status == "scheduled"
            ? startDate(dateYMD: effectiveDateString(), time: g.time) : nil
        // 잔루는 라이브 경기에만 부착(다이아몬드 표시용).
        let bases = g.status == "live" ? g.runnersOn : nil

        // 리치 필드(목업): 구장 / live=아웃·투타 / scheduled=선발 매치업
        let venue = g.stadium.isEmpty ? nil : g.stadium
        let outs = g.status == "live" ? g.outs : nil
        let pitcher = (g.status == "live" && !g.currentPitcher.isEmpty) ? g.currentPitcher : nil
        let batter = (g.status == "live" && !g.currentBatter.isEmpty) ? g.currentBatter : nil
        var starters: String? = nil
        if g.status == "scheduled", !g.awayStarterName.isEmpty, !g.homeStarterName.isEmpty {
            starters = "선발 \(g.awayStarterName) vs \(g.homeStarterName)"
        }

        return WatchSnapshot(kind: g.status, myTeamCode: myCode,
                             awayCode: awayCode, homeCode: homeCode,
                             awayScore: aScore, homeScore: hScore,
                             line: line, rankLine: rank, updatedAt: Date(),
                             startAt: startAt, bases: bases,
                             venue: venue, outs: outs, pitcher: pitcher, batter: batter,
                             starters: starters)
    }

    // MARK: - 다음 예정 경기 폴백 (오늘 경기 없을 때만)

    private static var kst: TimeZone { TimeZone(identifier: "Asia/Seoul") ?? .current }

    /// 이번 달 + 다음 달 "yyyy-MM" (월말에 이달 남은 경기가 없어도 다음 달까지 탐색).
    static func monthStrings(now: Date = Date()) -> [String] {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = kst
        let f = DateFormatter()
        f.timeZone = kst
        f.dateFormat = "yyyy-MM"
        let cur = f.string(from: now)
        let next = cal.date(byAdding: .month, value: 1, to: now).map { f.string(from: $0) } ?? cur
        return [cur, next]
    }

    /// 시작 1시간 이내로 임박했는지(오늘 경기 한정) — 원형 카운트다운 색상 강조용.
    static func isCountdownImminent(startAt: Date?, ref: Date = Date()) -> Bool {
        guard let start = startAt, isCountdownToday(start: start, ref: ref) else { return false }
        let secs = start.timeIntervalSince(ref)
        return secs > 0 && secs <= 3600
    }

    /// 예정 경기 시작 시각이 (06시 롤오버 기준) 오늘인지 — 오늘이면 카운트다운, 아니면 날짜 표기.
    static func isCountdownToday(start: Date, ref: Date = Date()) -> Bool {
        let f = DateFormatter()
        f.timeZone = kst
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd"
        return f.string(from: start) == effectiveDateString(now: ref)
    }

    /// 원형 컴플리케이션 아랫줄: 오늘 경기면 시작까지 남은 시간("5:41 후"/"41분 후"),
    /// 미래 경기면 날짜("7/16"). startAt 없으면 "예정".
    static func circularScheduleLabel(startAt: Date?, ref: Date = Date()) -> String {
        guard let start = startAt else { return "예정" }
        if isCountdownToday(start: start, ref: ref) {
            let secs = Int(start.timeIntervalSince(ref))
            if secs <= 0 { return "곧 시작" }
            let mins = secs / 60
            let h = mins / 60
            let m = mins % 60
            if h > 0 { return "\(h):" + String(format: "%02d", m) + " 후" }
            return "\(max(1, m))분 후"
        }
        let f = DateFormatter()
        f.timeZone = kst
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "M/d"
        return f.string(from: start)
    }

    /// "YYYYMMDD" + "18:30" → 시작 시각 Date(KST). 시간 없으면 nil(카운트다운 불가).
    static func startDate(dateYMD: String, time: String) -> Date? {
        guard !time.isEmpty else { return nil }
        let f = DateFormatter()
        f.timeZone = kst
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd HH:mm"
        return f.date(from: "\(dateYMD) \(time)")
    }

    /// "YYYYMMDD" + "18:30" → "7/15(수) 18:30" (시간 없으면 날짜만).
    static func scheduleLine(dateYMD: String, time: String) -> String {
        let inFmt = DateFormatter()
        inFmt.timeZone = kst
        inFmt.dateFormat = "yyyyMMdd"
        guard let d = inFmt.date(from: dateYMD) else {
            return time.isEmpty ? "다음 경기 예정" : time
        }
        let outFmt = DateFormatter()
        outFmt.timeZone = kst
        outFmt.locale = Locale(identifier: "ko_KR")
        outFmt.dateFormat = "M/d(E)"
        let datePart = outFmt.string(from: d)
        return time.isEmpty ? datePart : "\(datePart) \(time)"
    }

    /// 최애팀 slug로 team-schedule를 이달→다음달 순서로 조회, 첫 예정 경기 day를 반환.
    /// 실패/예정 없음이면 nil (noGame 폴백·final 하단 카드 생략).
    static func fetchNextGameDay(myId: Int, completion: @escaping (WatchScheduleDay?) -> Void) {
        let slug = WatchTeam.slug(fromId: myId)
        guard !slug.isEmpty else { completion(nil); return }
        let months = monthStrings()
        let fromDate = effectiveDateString()   // 이 값 이상(미래)의 scheduled만

        func tryMonth(_ idx: Int) {
            guard idx < months.count else { completion(nil); return }
            get("/api/team-schedule?team=\(slug)&month=\(months[idx])") { data in
                if let data,
                   let parsed = try? JSONDecoder().decode(WatchScheduleResponse.self, from: data),
                   let day = parsed.days.first(where: { $0.status == "scheduled" && $0.date >= fromDate }) {
                    completion(day)
                } else {
                    tryMonth(idx + 1)
                }
            }
        }
        tryMonth(0)
    }

    /// 다음 예정 경기 → 기존 "scheduled" 렌더 경로 재사용(매치업 + 날짜/시각 라인).
    static func nextSnapshot(myCode: String, day: WatchScheduleDay, rank: String) -> WatchSnapshot {
        let oppCode = WatchTeam.code(fromId: day.opponentId)
        let awayCode = day.home ? oppCode : myCode
        let homeCode = day.home ? myCode : oppCode
        let line = scheduleLine(dateYMD: day.date, time: day.time)
        return WatchSnapshot(kind: "scheduled", myTeamCode: myCode,
                             awayCode: awayCode, homeCode: homeCode,
                             awayScore: 0, homeScore: 0,
                             line: line, rankLine: rank, updatedAt: Date(),
                             startAt: startDate(dateYMD: day.date, time: day.time), bases: nil,
                             venue: day.stadium.isEmpty ? nil : day.stadium)
    }
}

// MARK: - 잔루 다이아몬드 (라이브 카드 — "1·3루" 글자 대신 시각 표시)

/// 1·2·3루 점유를 야구 다이아몬드로 표시. 점유 시 채움, 비었으면 옅은 아웃라인.
struct BaseDiamond: View {
    let bases: WatchBases
    var size: CGFloat = 14
    var onColor: Color = Color(red: 1.0, green: 0.42, blue: 0.48)

    private var pip: CGFloat { size * 0.42 }
    private func base(_ on: Bool) -> some View {
        RoundedRectangle(cornerRadius: 1.5)
            .fill(on ? onColor : Color.white.opacity(0.22))
            .frame(width: pip, height: pip)
            .rotationEffect(.degrees(45))
    }
    var body: some View {
        ZStack {
            base(bases.second).offset(y: -size * 0.27)   // 2루(위)
            base(bases.third).offset(x: -size * 0.27)     // 3루(왼쪽)
            base(bases.first).offset(x: size * 0.27)      // 1루(오른쪽)
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Text("주자 상황"))
    }
}
