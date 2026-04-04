/* ===== KBO 공식 API 크롤러 ===== */

import playersRoster from "@/lib/constants/players-roster.json";

const KBO_BASE = "https://www.koreabaseball.com";

// KBO 팀 코드 → 앱 teamId 매핑
const TEAM_CODE_MAP: Record<string, number> = {
  LG: 1, OB: 2, KT: 3, SK: 4, NC: 5,
  HT: 6, LT: 7, SS: 8, HH: 9, WO: 10,
};

export interface KboGame {
  gameId: string;
  date: string;
  time: string;
  stadium: string;
  awayTeamId: number;
  homeTeamId: number;
  awayName: string;
  homeName: string;
  awayScore: number | null;
  homeScore: number | null;
  inning: number;
  isTop: boolean; // 초(true) / 말(false)
  status: "scheduled" | "live" | "final" | "cancelled";
  // 선발 투수
  awayStarterName: string;
  homeStarterName: string;
  // 결과 투수
  winPitcher: string;
  losePitcher: string;
  savePitcher: string;
  // 라이브 데이터
  strikes: number;
  balls: number;
  outs: number;
  runnersOn: { first: boolean; second: boolean; third: boolean };
  currentPitcher: string;
  currentBatter: string;
  // 순위
  awayRank: number;
  homeRank: number;
}

function parseGameStatus(stateCode: string, cancelCode: string): KboGame["status"] {
  if (cancelCode !== "0") return "cancelled";
  if (stateCode === "3") return "final";
  if (stateCode === "2") return "live";
  return "scheduled";
}

interface KboGameRaw {
  G_ID: string;
  G_DT: string;
  G_TM: string;
  S_NM: string;
  AWAY_ID: string;
  HOME_ID: string;
  AWAY_NM: string;
  HOME_NM: string;
  T_SCORE_CN: string;
  B_SCORE_CN: string;
  GAME_INN_NO: number;
  GAME_TB_SC: string;
  GAME_STATE_SC: string;
  CANCEL_SC_ID: string;
  T_PIT_P_NM: string;
  B_PIT_P_NM: string;
  W_PIT_P_NM: string;
  L_PIT_P_NM: string;
  SV_PIT_P_NM: string;
  STRIKE_CN: number;
  BALL_CN: number;
  OUT_CN: number;
  B1_BAT_ORDER_NO: number;
  B2_BAT_ORDER_NO: number;
  B3_BAT_ORDER_NO: number;
  B_P_NM: string;
  T_P_NM: string;
  T_RANK_NO: number;
  B_RANK_NO: number;
}

function parseGame(raw: KboGameRaw): KboGame {
  const status = parseGameStatus(raw.GAME_STATE_SC?.toString(), raw.CANCEL_SC_ID?.toString());
  const isTop = raw.GAME_TB_SC === "T";
  return {
    gameId: raw.G_ID,
    date: raw.G_DT,
    time: raw.G_TM,
    stadium: raw.S_NM,
    awayTeamId: TEAM_CODE_MAP[raw.AWAY_ID] ?? 0,
    homeTeamId: TEAM_CODE_MAP[raw.HOME_ID] ?? 0,
    awayName: raw.AWAY_NM,
    homeName: raw.HOME_NM,
    awayScore: status !== "scheduled" ? parseInt(raw.T_SCORE_CN) || 0 : null,
    homeScore: status !== "scheduled" ? parseInt(raw.B_SCORE_CN) || 0 : null,
    inning: raw.GAME_INN_NO ?? 0,
    isTop,
    status,
    awayStarterName: raw.T_PIT_P_NM?.trim() ?? "",
    homeStarterName: raw.B_PIT_P_NM?.trim() ?? "",
    winPitcher: raw.W_PIT_P_NM?.trim() ?? "",
    losePitcher: raw.L_PIT_P_NM?.trim() ?? "",
    savePitcher: raw.SV_PIT_P_NM?.trim() ?? "",
    strikes: raw.STRIKE_CN ?? 0,
    balls: raw.BALL_CN ?? 0,
    outs: raw.OUT_CN ?? 0,
    runnersOn: {
      first: (raw.B1_BAT_ORDER_NO ?? 0) > 0,
      second: (raw.B2_BAT_ORDER_NO ?? 0) > 0,
      third: (raw.B3_BAT_ORDER_NO ?? 0) > 0,
    },
    currentPitcher: isTop ? (raw.B_P_NM?.trim() ?? "") : (raw.T_P_NM?.trim() ?? ""),
    currentBatter: isTop ? (raw.T_P_NM?.trim() ?? "") : (raw.B_P_NM?.trim() ?? ""),
    awayRank: raw.T_RANK_NO ?? 0,
    homeRank: raw.B_RANK_NO ?? 0,
  };
}

/** 특정 날짜 경기 목록 조회 */
export async function fetchGames(date: string): Promise<KboGame[]> {
  const res = await fetch(`${KBO_BASE}/ws/Main.asmx/GetKboGameList`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({ leId: "1", srId: "0,1,3,4,5,7,9", date }),
  });

  const text = await res.text();
  // ASP.NET 에러 HTML이 뒤에 붙을 수 있음
  const jsonEnd = text.indexOf("}<!") ;
  const jsonStr = jsonEnd > 0 ? text.slice(0, jsonEnd + 1) : text;
  const data = JSON.parse(jsonStr);

  return (data.game ?? []).map(parseGame);
}

/** 이전/다음 경기일 조회 */
export async function fetchGameDates(date: string): Promise<{ before: string; current: string; after: string }> {
  const res = await fetch(`${KBO_BASE}/ws/Main.asmx/GetKboGameDate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({ leId: "1", srId: "0,1", date }),
  });

  const text = await res.text();
  const jsonEnd = text.indexOf("}<!") ;
  const jsonStr = jsonEnd > 0 ? text.slice(0, jsonEnd + 1) : text;
  const data = JSON.parse(jsonStr);

  return {
    before: data.BEFORE_G_DT,
    current: data.NOW_G_DT,
    after: data.AFTER_G_DT,
  };
}

export interface TeamStanding {
  teamName: string;
  teamId: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  gamesBehind: number;
}

/** 팀 순위 (HTML 파싱) */
export async function fetchStandings(): Promise<TeamStanding[]> {
  const res = await fetch(`${KBO_BASE}/Record/TeamRank/TeamRank.aspx`);
  const html = await res.text();

  const rows = html.split("<tr").slice(1).map(r => r.split("</tr>")[0]);
  const standings: TeamStanding[] = [];

  for (const row of rows) {
    const cells = row.split("<td").slice(1)
      .map(c => c.split("</td>")[0].replace(/<[^>]+>/g, "").replace(/^[^>]*>/, "").trim());

    if (cells.length >= 8 && /^\d+$/.test(cells[0])) {
      const teamName = cells[1];
      standings.push({
        teamName,
        teamId: Object.entries(TEAM_CODE_MAP).find(([_, id]) => {
          const names: Record<number, string> = {
            1: "LG", 2: "두산", 3: "KT", 4: "SSG", 5: "NC",
            6: "KIA", 7: "롯데", 8: "삼성", 9: "한화", 10: "키움",
          };
          return names[id] === teamName;
        })?.[1] ?? 0,
        games: parseInt(cells[2]) || 0,
        wins: parseInt(cells[3]) || 0,
        losses: parseInt(cells[4]) || 0,
        draws: parseInt(cells[5]) || 0,
        winRate: parseFloat(cells[6]) || 0,
        gamesBehind: parseFloat(cells[7]) || 0,
      });
    }
  }

  return standings;
}

// ===== BoxScore types & parser (shared with game-detail) =====

const KBO_SCHEDULE_BASE = "https://www.koreabaseball.com/ws/Schedule.asmx";
const SCHEDULE_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
};

export interface BoxScoreBatterRecord {
  order: number;
  position: string;
  name: string;
  atBats: number;
  hits: number;
  runs: number;
  rbi: number;
  hr: number;
  bb: number;
  so: number;
  sb: number;
  avg: string;
  isSubstitute: boolean;
}

export interface BoxScorePitcherRecord {
  name: string;
  inningsPitched: string;
  decision: string;
  pitchCount: number;
  hits: number;
  runs: number;
  hr: number;
  strikeouts: number;
  walks: number;
  earnedRuns: number;
  era: string;
}

export interface BoxScoreResult {
  awayBatters: BoxScoreBatterRecord[];
  homeBatters: BoxScoreBatterRecord[];
  awayPitchers: BoxScorePitcherRecord[];
  homePitchers: BoxScorePitcherRecord[];
}

function bsSafeInt(v: unknown): number {
  if (v == null || v === "" || v === "&nbsp;") return 0;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

function bsSafeStr(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "&nbsp;" ? "" : s;
}

function bsStripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

const BS_POS_MAP: Record<string, string> = {
  "투수": "P", "포수": "C", "1루수": "1B", "2루수": "2B",
  "3루수": "3B", "유격수": "SS", "좌익수": "LF", "중견수": "CF",
  "우익수": "RF", "지명타자": "DH",
  "타지": "DH", "타좌": "LF", "타우": "RF", "타중": "CF",
  "타1": "1B", "타2": "2B", "타3": "3B", "타유": "SS", "타포": "C",
  "주좌": "LF", "주우": "RF", "주중": "CF", "주1": "1B", "주2": "2B", "주3": "3B", "주유": "SS",
  "대타": "DH", "대주": "DH",
};

export function parseBoxScore(data: unknown): BoxScoreResult | null {
  const obj = data as { tables?: unknown[]; code?: string };
  if (!obj?.tables || !Array.isArray(obj.tables) || obj.tables.length < 5) return null;

  // Parse stolen bases from key plays table (table[0])
  const sbMap = new Map<string, number>();
  const keyPlaysTable = obj.tables[0] as { rows?: { row: { Text: string }[] }[] };
  if (keyPlaysTable?.rows) {
    for (const r of keyPlaysTable.rows) {
      const cells = r.row.map(c => bsSafeStr(c.Text));
      if (bsStripHtml(cells[0]) === "도루") {
        const text = bsStripHtml(cells[1] || "");
        const matches = text.matchAll(/([가-힣]+?)(\d*)\(/g);
        for (const m of matches) {
          const name = m[1];
          const count = m[2] ? parseInt(m[2]) : 1;
          sbMap.set(name, (sbMap.get(name) || 0) + count);
        }
      }
    }
  }

  function parseBatters(table: { rows?: { row: { Text: string }[] }[] }, sbLookup: Map<string, number>): BoxScoreBatterRecord[] {
    if (!table?.rows) return [];
    let prevOrder = -1;
    return table.rows.map(r => {
      const cells = r.row.map(c => bsSafeStr(c.Text));
      const tail = cells.slice(cells.length - 5);
      const atBatResults = cells.slice(3, cells.length - 5).map(c => bsStripHtml(c)).filter(c => c && c !== "&nbsp;");

      let hr = 0, bb = 0, so = 0;
      for (const ab of atBatResults) {
        if (ab.includes("홈")) hr++;
        if (ab === "4구") bb++;
        if (ab.includes("삼진")) so++;
      }

      const order = bsSafeInt(bsStripHtml(cells[0]));
      const posRaw = bsStripHtml(cells[1] || "");
      const isSubstitute = order === prevOrder || posRaw.startsWith("타") || posRaw.startsWith("주") || posRaw.startsWith("대");
      prevOrder = order;

      return {
        order,
        position: BS_POS_MAP[posRaw] || posRaw,
        name: bsStripHtml(cells[2] || ""),
        atBats: bsSafeInt(bsStripHtml(tail[0])),
        hits: bsSafeInt(bsStripHtml(tail[1])),
        rbi: bsSafeInt(bsStripHtml(tail[2])),
        runs: bsSafeInt(bsStripHtml(tail[3])),
        hr,
        bb,
        so,
        sb: sbLookup.get(bsStripHtml(cells[2] || "")) || 0,
        avg: bsStripHtml(tail[4]) || ".000",
        isSubstitute,
      };
    }).filter(b => b.name !== "").map(b => {
      if (/^\d+$/.test(b.name)) {
        const player = (playersRoster as { kboId: string; name: string }[]).find(
          r => String(r.kboId) === b.name
        );
        b.name = player ? player.name : `선수(${b.name.slice(-3)})`;
      }
      return b;
    });
  }

  function parsePitchers(table: { rows?: { row: { Text: string }[] }[] }): BoxScorePitcherRecord[] {
    if (!table?.rows) return [];
    return table.rows.map(r => {
      const cells = r.row.map(c => bsSafeStr(c.Text));
      const ip = bsStripHtml(cells[6] || "");
      return {
        name: bsStripHtml(cells[0] || ""),
        inningsPitched: ip,
        decision: bsStripHtml(cells[2] || ""),
        pitchCount: bsSafeInt(bsStripHtml(cells[8])),
        hits: bsSafeInt(bsStripHtml(cells[10])),
        hr: bsSafeInt(bsStripHtml(cells[11])),
        walks: bsSafeInt(bsStripHtml(cells[12])),
        strikeouts: bsSafeInt(bsStripHtml(cells[13])),
        runs: bsSafeInt(bsStripHtml(cells[14])),
        earnedRuns: bsSafeInt(bsStripHtml(cells[15])),
        era: bsStripHtml(cells[16] || "") || "0.00",
      };
    }).filter(p => p.name !== "").map(p => {
      if (/^\d+$/.test(p.name)) {
        const player = (playersRoster as { kboId: string; name: string }[]).find(
          r => String(r.kboId) === p.name
        );
        p.name = player ? player.name : `선수(${p.name.slice(-3)})`;
      }
      return p;
    });
  }

  const tables = obj.tables as { rows?: { row: { Text: string }[] }[] }[];

  return {
    awayBatters: parseBatters(tables[1], sbMap),
    homeBatters: parseBatters(tables[2], sbMap),
    awayPitchers: parsePitchers(tables[3]),
    homePitchers: parsePitchers(tables[4]),
  };
}

/** BoxScore 조회 (특정 경기) */
export async function fetchBoxScore(gameId: string, seasonId?: string): Promise<BoxScoreResult | null> {
  try {
    const sid = seasonId || new Date().getFullYear().toString();
    const body = `leId=1&srId=0&seasonId=${sid}&gameId=${gameId}`;
    const res = await fetch(`${KBO_SCHEDULE_BASE}/GetBoxScore`, {
      method: "POST",
      headers: SCHEDULE_HEADERS,
      body,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return parseBoxScore(data);
  } catch {
    return null;
  }
}

export interface PlayerBattingStat {
  rank: number;
  name: string;
  team: string;
  avg: number;
  games: number;
  pa: number;
  ab: number;
  runs: number;
  hits: number;
  doubles: number;
}

/** 타자 기록 (HTML 파싱) */
export async function fetchBatterStats(): Promise<PlayerBattingStat[]> {
  const res = await fetch(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx`);
  const html = await res.text();

  const rows = html.match(/<tr[^>]*>(.*?)<\/tr>/g) ?? [];
  const stats: PlayerBattingStat[] = [];

  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>(.*?)<\/td>/g) ?? [])
      .map(c => c.replace(/<[^>]+>/g, "").trim());

    if (cells.length >= 10 && /^\d+$/.test(cells[0])) {
      stats.push({
        rank: parseInt(cells[0]),
        name: cells[1],
        team: cells[2],
        avg: parseFloat(cells[3]) || 0,
        games: parseInt(cells[4]) || 0,
        pa: parseInt(cells[5]) || 0,
        ab: parseInt(cells[6]) || 0,
        runs: parseInt(cells[7]) || 0,
        hits: parseInt(cells[8]) || 0,
        doubles: parseInt(cells[9]) || 0,
      });
    }
  }

  return stats;
}
