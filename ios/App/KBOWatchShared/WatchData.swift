//
//  WatchData.swift
//  워치 앱·컴플리케이션 공유 데이터 레이어 (두 watch 타깃에 모두 멤버십).
//
//  서버 무변경 원칙: 홈 위젯과 동일하게 keubo.fan 공개 API(/api/games·/api/standings)를
//  직접 fetch하고 App Group에 캐시한다(오프라인/실패 시 폴백). 최애팀 코드는 iPhone 앱이
//  WCSession applicationContext로 보내준 값을 워치 앱이 App Group에 기록한 것을 읽는다.
//

import Foundation

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

struct WatchGame: Codable {
    var time: String
    var awayTeamId: Int
    var homeTeamId: Int
    var awayScore: Int?
    var homeScore: Int?
    var inning: Int
    var isTop: Bool
    var status: String   // "scheduled" | "live" | "final" | "cancelled"
    var outs: Int

    enum CodingKeys: String, CodingKey {
        case time, awayTeamId, homeTeamId, awayScore, homeScore, inning, isTop, status, outs
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        time = (try? c.decodeIfPresent(String.self, forKey: .time)) ?? ""
        awayTeamId = (try? c.decodeIfPresent(Int.self, forKey: .awayTeamId)) ?? 0
        homeTeamId = (try? c.decodeIfPresent(Int.self, forKey: .homeTeamId)) ?? 0
        awayScore = try? c.decodeIfPresent(Int.self, forKey: .awayScore)
        homeScore = try? c.decodeIfPresent(Int.self, forKey: .homeScore)
        inning = (try? c.decodeIfPresent(Int.self, forKey: .inning)) ?? 0
        isTop = (try? c.decodeIfPresent(Bool.self, forKey: .isTop)) ?? true
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "scheduled"
        outs = (try? c.decodeIfPresent(Int.self, forKey: .outs)) ?? 0
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

    enum CodingKeys: String, CodingKey { case date, status, home, time, opponent }
    enum OppKeys: String, CodingKey { case id }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = (try? c.decodeIfPresent(String.self, forKey: .date)) ?? ""
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "scheduled"
        home = (try? c.decodeIfPresent(Bool.self, forKey: .home)) ?? false
        time = (try? c.decodeIfPresent(String.self, forKey: .time)) ?? ""
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
    var rankLine: String    // "2위 · 1.5G" (순위 미확보 시 "")
    var updatedAt: Date

    var isLive: Bool { kind == "live" }
    var hasScore: Bool { kind == "live" || kind == "final" }

    static func noTeam() -> WatchSnapshot {
        WatchSnapshot(kind: "noTeam", myTeamCode: "", awayCode: "", homeCode: "",
                      awayScore: 0, homeScore: 0,
                      line: "크보팬 앱에서 최애팀을 선택하세요", rankLine: "", updatedAt: Date())
    }

    /// 위젯 갤러리/스냅샷용 익명 더미(실팀 노출 금지 — 폰 위젯 미리보기 폴리시와 동일).
    static func previewDummy() -> WatchSnapshot {
        WatchSnapshot(kind: "live", myTeamCode: "", awayCode: "수달스", homeCode: "돌고래스",
                      awayScore: 3, homeScore: 5,
                      line: "LIVE 7회말 · 1사", rankLine: "2위 · 1.5G",
                      updatedAt: Date(timeIntervalSince1970: 1_783_600_000))
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
            let snap = compose(myCode: myCode, myId: myId, games: games, rankRow: rankRow)
            // 오늘 최애팀 경기가 없으면 "오늘 경기 없음" 대신 다음 예정 경기를 보여준다
            // (올스타 브레이크·팀 휴식일 대응). 예정 경기도 없으면 compose의 noGame 유지.
            if snap.kind == "noGame" {
                fetchNextGame(myCode: myCode, myId: myId, rank: snap.rankLine) { nextSnap in
                    let final = nextSnap ?? snap
                    WatchStore.saveCachedSnapshot(final)
                    completion(final)
                }
                return
            }
            if gamesOk { WatchStore.saveCachedSnapshot(snap) }
            completion(snap)
        }
    }

    static func rankLine(_ row: WatchRankRow?) -> String {
        guard let row, row.ranking > 0 else { return "" }
        let gb = row.gamesBehind
        guard gb > 0 else { return "\(row.ranking)위" }
        let gbText = gb == gb.rounded(.down) ? String(Int(gb)) : String(format: "%.1f", gb)
        return "\(row.ranking)위 · \(gbText)G"
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
                                 line: "오늘 경기 없음", rankLine: rank, updatedAt: Date())
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

        return WatchSnapshot(kind: g.status, myTeamCode: myCode,
                             awayCode: awayCode, homeCode: homeCode,
                             awayScore: aScore, homeScore: hScore,
                             line: line, rankLine: rank, updatedAt: Date())
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

    /// 최애팀 slug로 team-schedule를 이달→다음달 순서로 조회, 첫 예정 경기를 스냅샷으로.
    /// 실패/예정 없음이면 nil (호출부가 "오늘 경기 없음" 폴백).
    static func fetchNextGame(myCode: String, myId: Int, rank: String,
                              completion: @escaping (WatchSnapshot?) -> Void) {
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
                    completion(nextSnapshot(myCode: myCode, day: day, rank: rank))
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
                             line: line, rankLine: rank, updatedAt: Date())
    }
}
