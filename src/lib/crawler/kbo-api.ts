/* ===== KBO 공식 API 크롤러 ===== */

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

function parseGame(raw: any): KboGame {
  const status = parseGameStatus(raw.GAME_STATE_SC?.toString(), raw.CANCEL_SC_ID?.toString());
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
    isTop: raw.GAME_TB_SC === "T",
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
    currentPitcher: raw.B_P_NM?.trim() ?? "",
    currentBatter: raw.T_P_NM?.trim() ?? "",
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
