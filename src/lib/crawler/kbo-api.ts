/* ===== KBO 공식 API 크롤러 ===== */

import { resolvePlayer } from "@/lib/utils/resolve-player";
import { trackFallback } from "@/lib/monitoring/api-fallback-tracker";
import { parseTeamRegister, type RosterEntry } from "@/lib/roster-moves/parse";
import { RosterCollectionError, validateRosterCollection } from "@/lib/roster-moves/collection";
// 수집 sanity 검증/예외는 순수 모듈(roster-moves/collection.ts)에 두고 재노출(스모크가 supabase 의존 없이 import).
export { RosterCollectionError, validateRosterCollection } from "@/lib/roster-moves/collection";
import { decodeBroadcast, type BroadcastChannel } from "@/lib/broadcast-channels";
import { ALLSTAR_CODE_TO_ID, allstarTeamIdByName } from "@/lib/constants/teams";

/** 숫자 kboId로 로스터 조회 — 외국인 숫자→영문 변환 포함 */
function findPlayerByNumericId(numericId: string): { name: string } | undefined {
  const resolved = resolvePlayer(String(numericId), undefined, { context: "kbo-api:boxscore" });
  return resolved ? { name: resolved.name } : undefined;
}

const KBO_BASE = "https://www.koreabaseball.com";

// 2026-05-20: KBO 서버가 User-Agent 없는 요청에 IE 분기 에러 페이지를 내려줌 → JSON 파싱 실패.
// Vercel 서버리스 fetch는 기본 UA가 없으므로 모든 KBO 직접 호출에 브라우저 UA를 강제한다.
const KBO_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const KBO_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent": KBO_BROWSER_UA,
  "Referer": "https://www.koreabaseball.com/Schedule/Schedule.aspx",
};
const KBO_HTML_HEADERS = {
  "User-Agent": KBO_BROWSER_UA,
  "Referer": "https://www.koreabaseball.com/",
};

// KBO 팀 코드 → 앱 teamId 매핑
const TEAM_CODE_MAP: Record<string, number> = {
  LG: 1, OB: 2, KT: 3, SK: 4, NC: 5,
  HT: 6, LT: 7, SS: 8, HH: 9, WO: 10,
};

/** KBO 팀 코드 → 앱 teamId. 정규 10구단에 없으면 올스타(코드 → 팀명 순)로 해석,
 *  그래도 없으면 0. 올스타는 코드가 팀맵에 없어 예전엔 0으로 뭉개져 렌더가 터졌다. */
function resolveTeamId(code: string, name: string): number {
  return TEAM_CODE_MAP[code] ?? ALLSTAR_CODE_TO_ID[code] ?? allstarTeamIdByName(name) ?? 0;
}

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
  // 중계방송사(TV/IPTV, 라디오 제외). 없으면 undefined.
  broadcastChannels?: BroadcastChannel[];
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
  TV_IF?: string;
}

function parseGame(raw: KboGameRaw): KboGame {
  const status = parseGameStatus(raw.GAME_STATE_SC?.toString(), raw.CANCEL_SC_ID?.toString());
  const isTop = raw.GAME_TB_SC === "T";
  return {
    gameId: raw.G_ID,
    date: raw.G_DT,
    time: raw.G_TM,
    stadium: raw.S_NM,
    awayTeamId: resolveTeamId(raw.AWAY_ID, raw.AWAY_NM),
    homeTeamId: resolveTeamId(raw.HOME_ID, raw.HOME_NM),
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
    broadcastChannels: decodeBroadcast(raw.TV_IF),
  };
}

/** 특정 날짜 경기 목록 조회 */
export async function fetchGames(date: string, srId = "0,1,3,4,5,7,9"): Promise<KboGame[]> {
  try {
    const res = await fetch(`${KBO_BASE}/ws/Main.asmx/GetKboGameList`, {
      method: "POST",
      headers: KBO_JSON_HEADERS,
      body: JSON.stringify({ leId: "1", srId, date }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      await trackFallback("kbo-games", "http-error", {
        statusCode: res.status,
        errorMessage: `HTTP ${res.status} ${res.statusText}`,
      });
      throw new Error(`HTTP ${res.status}`);
    }

    const text = await res.text();
    // ASP.NET 에러 HTML이 뒤에 붙을 수 있음
    const jsonEnd = text.indexOf("}<!");
    const jsonStr = jsonEnd > 0 ? text.slice(0, jsonEnd + 1) : text;
    const data = JSON.parse(jsonStr);

    return (data.game ?? []).map(parseGame);
  } catch (e) {
    const error = e as Error;
    let reason: "timeout" | "http-error" | "schema-error" | "network-error" = "network-error";
    if (error.name === "TimeoutError" || error.message.includes("timeout")) {
      reason = "timeout";
    } else if (error.message.includes("HTTP")) {
      reason = "http-error";
    } else if (error.message.includes("JSON")) {
      reason = "schema-error";
    }

    await trackFallback("kbo-games", reason, {
      errorMessage: error.message,
    });

    throw error;
  }
}

/** 이전/다음 경기일 조회 */
export async function fetchGameDates(date: string): Promise<{ before: string; current: string; after: string }> {
  const res = await fetch(`${KBO_BASE}/ws/Main.asmx/GetKboGameDate`, {
    method: "POST",
    headers: KBO_JSON_HEADERS,
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
  /** 네이버 API 원본 순위(공동순위 반영). 없으면 0/undefined → 승률 기반 fallback. */
  ranking?: number;
  /** 연승/연패 원본 문자열 (예: "3승", "1패"). 없으면 undefined. */
  continuousGameResult?: string;
}

/**
 * 순위 산정 — 공동순위(ties) 보존 (4/11 핫픽스 001bf82c 기준):
 *  - 네이버 API 원본 `ranking`(공동순위 반영)이 있으면 그대로 사용.
 *  - 없으면(KBO HTML 폴백 등) 승률 내림차순 competition ranking — 동률은 같은 순위(1,2,2,4…).
 * winRate-sort + index+1 단순 방식은 공동순위를 깨므로 쓰지 않는다(삼순 #406 NO-GO).
 */
export function rankStandings(standings: TeamStanding[]): { teamId: number; teamName: string; rank: number }[] {
  const hasRanking = standings.some((s) => s.ranking != null && s.ranking > 0);
  if (hasRanking) {
    return standings
      .filter((s) => s.teamId)
      .map((s) => ({ teamId: s.teamId, teamName: s.teamName, rank: s.ranking as number }));
  }
  const sorted = [...standings].sort((a, b) => b.winRate - a.winRate);
  let currentRank = 1;
  return sorted.map((s, i) => {
    if (i > 0 && s.winRate !== sorted[i - 1].winRate) currentRank = i + 1;
    return { teamId: s.teamId, teamName: s.teamName, rank: currentRank };
  });
}

/** teamId → 순위 맵 (공동순위 보존). 순위표 렌더/프리뷰/요약의 순위 표기에 공통 사용. */
export function buildRankMap(standings: TeamStanding[]): Map<number, number> {
  return new Map(rankStandings(standings).map((r) => [r.teamId, r.rank]));
}

/** 팀 순위 (HTML 파싱) */
/** 팀 순위 (네이버 API → KBO HTML 폴백) */
export async function fetchStandings(): Promise<TeamStanding[]> {
  try {
    // Primary: 네이버 실시간 API (빠름)
    const naverRes = await fetch(
      "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons/2026/teams?gameType=REGULAR_SEASON",
      {
        headers: {
          "Referer": "https://sports.news.naver.com/",
          "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
        },
        signal: AbortSignal.timeout(5000),
        cache: "no-store",
      }
    );

    if (naverRes.ok) {
      const data = await naverRes.json();
      if (data.success && data.result?.seasonTeamStats) {
        return data.result.seasonTeamStats.map((team: { teamName: string; teamId: string; gameCount?: number; winGameCount?: number; loseGameCount?: number; drawnGameCount?: number; wra?: number; gameBehind?: number; ranking?: number; continuousGameResult?: string }) => ({
          teamName: team.teamName,
          teamId: TEAM_CODE_MAP[team.teamId] ?? 0,
          games: team.gameCount ?? 0,
          wins: team.winGameCount ?? 0,
          losses: team.loseGameCount ?? 0,
          draws: team.drawnGameCount ?? 0,
          winRate: team.wra ?? 0,
          gamesBehind: team.gameBehind ?? 0,
          ranking: team.ranking ?? 0,
          continuousGameResult: team.continuousGameResult,
        }));
      }
    }
  } catch (e) {
    const error = e as Error;
    console.warn("[fetchStandings] Naver API failed, falling back to KBO HTML:", error.message);

    // Fallback 추적 + 알림
    let reason: "timeout" | "http-error" | "schema-error" | "network-error" = "network-error";
    if (error.name === "TimeoutError" || error.message.includes("timeout")) {
      reason = "timeout";
    } else if (error.message.includes("HTTP") || error.message.includes("status")) {
      reason = "http-error";
    } else if (error.message.includes("JSON") || error.message.includes("schema")) {
      reason = "schema-error";
    }

    await trackFallback("naver-standings", reason, {
      errorMessage: error.message,
    });
  }

  // Fallback: KBO HTML 크롤링 (느림)
  const res = await fetch(`${KBO_BASE}/Record/TeamRank/TeamRank.aspx`, { headers: KBO_HTML_HEADERS });
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
  // 2026-05-20: KBO가 KboEveryday/1.0 같은 식별 UA를 차단하기 시작 → 일반 브라우저 UA로 전환.
  "User-Agent": KBO_BROWSER_UA,
  "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
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
        const player = findPlayerByNumericId(b.name);
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
        const player = findPlayerByNumericId(p.name);
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
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      await trackFallback("kbo-boxscore", "http-error", {
        statusCode: res.status,
        errorMessage: `HTTP ${res.status} ${res.statusText}`,
      });
      return null;
    }

    const data = await res.json();
    return parseBoxScore(data);
  } catch (e) {
    const error = e as Error;
    let reason: "timeout" | "http-error" | "schema-error" | "network-error" = "network-error";
    if (error.name === "TimeoutError" || error.message.includes("timeout")) {
      reason = "timeout";
    } else if (error.message.includes("HTTP")) {
      reason = "http-error";
    } else if (error.message.includes("JSON")) {
      reason = "schema-error";
    }

    await trackFallback("kbo-boxscore", reason, {
      errorMessage: error.message,
    });

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
  const res = await fetch(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx`, { headers: KBO_HTML_HEADERS });
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

/* ===== 선수 등록 현황 (1군 로스터 스냅샷) ===== */
// 2026-07-18: 팀별 선수 등록/말소 내역 기능. Register.aspx는 ASP.NET WebForms —
// 최초 GET으로 폼 토큰(__VIEWSTATE 등)을 얻고, 구단 탭 전환은 hfSearchTeam을 바꿔
// btnCalendarSelect postback으로 요청한다(실측 확인: 동일 __VIEWSTATE로 10개 구단 순회 가능).
const REGISTER_URL = `${KBO_BASE}/Player/Register.aspx`;
const REGISTER_POSTBACK_TARGET = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$btnCalendarSelect";
const REGISTER_TEAM_FIELD = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchTeam";
const REGISTER_DATE_FIELD = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchDate";
const REGISTER_DATE_HIDDEN_ID = "cphContents_cphContents_cphContents_hfSearchDate";

export interface TeamRosterSnapshot {
  teamId: number;
  teamCode: string;
  entries: RosterEntry[];
}

export interface RegisterRosters {
  /** KBO 기준 등록명단 일자 (YYYYMMDD). */
  date: string;
  teams: TeamRosterSnapshot[];
}

function extractRegisterHidden(html: string, id: string): string {
  const m = html.match(new RegExp(`id="${id}" value="([^"]*)"`));
  return m ? m[1] : "";
}

/**
 * 10개 구단 1군 등록명단 스냅샷을 GET 1 + 구단별 POST 10회로 수집.
 * 실패를 조용히 성공으로 묻지 않는다(삼순 P1): HTTP status/WebForms 토큰/날짜/인원수를
 * 검증하고 하나라도 실패하면 RosterCollectionError를 throw한다(호출측 cron이 fail-closed).
 */
export async function fetchRegisterRosters(): Promise<RegisterRosters> {
  const initRes = await fetch(REGISTER_URL, { headers: { ...KBO_HTML_HEADERS, Referer: REGISTER_URL } });
  if (!initRes.ok) {
    throw new RosterCollectionError(`Register.aspx GET HTTP ${initRes.status}`);
  }
  const initHtml = await initRes.text();
  const viewState = extractRegisterHidden(initHtml, "__VIEWSTATE");
  const viewStateGen = extractRegisterHidden(initHtml, "__VIEWSTATEGENERATOR");
  const eventValidation = extractRegisterHidden(initHtml, "__EVENTVALIDATION");
  const date = extractRegisterHidden(initHtml, REGISTER_DATE_HIDDEN_ID);
  // WebForms 폼 토큰 추출 실패(마크업 변경/차단) = 명시 에러 — postback이 무의미해진다.
  if (!viewState || !eventValidation) {
    throw new RosterCollectionError("Register.aspx 폼 토큰(__VIEWSTATE/__EVENTVALIDATION) 추출 실패");
  }
  if (!/^\d{8}$/.test(date)) {
    throw new RosterCollectionError(`Register.aspx 등록명단 날짜 추출 이상: "${date}"`);
  }

  const teams: TeamRosterSnapshot[] = [];
  for (const [code, teamId] of Object.entries(TEAM_CODE_MAP)) {
    const body = new URLSearchParams({
      __EVENTTARGET: REGISTER_POSTBACK_TARGET,
      __EVENTARGUMENT: "",
      __VIEWSTATE: viewState,
      __VIEWSTATEGENERATOR: viewStateGen,
      __EVENTVALIDATION: eventValidation,
      [REGISTER_TEAM_FIELD]: code,
      [REGISTER_DATE_FIELD]: date,
    });
    const res = await fetch(REGISTER_URL, {
      method: "POST",
      headers: {
        ...KBO_HTML_HEADERS,
        Referer: REGISTER_URL,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new RosterCollectionError(`Register.aspx POST HTTP ${res.status} (team ${code})`);
    }
    const html = await res.text();
    teams.push({ teamId, teamCode: code, entries: parseTeamRegister(html) });
  }

  // 10구단/팀당 인원 sanity — 0명/부분 수집을 성공으로 넣지 않는다.
  const sanity = validateRosterCollection(date, teams);
  if (sanity) {
    throw new RosterCollectionError(sanity);
  }

  return { date, teams };
}
