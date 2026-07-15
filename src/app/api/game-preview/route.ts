import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import playersRoster from "@/lib/constants/players-roster.json";
import batterStats from "@/lib/constants/stats-2026-batters.json";
import pitcherStats from "@/lib/constants/stats-2026-pitchers.json";
import { TEAMS, isAllStarGame, isAllStarGameId } from "@/lib/constants/teams";
import { INJURY_BLOCKLIST_KEYS } from "@/lib/constants/injury-blocklist";
import { fetchStandings, buildRankMap, fetchGames, fetchBoxScore, type TeamStanding, type BoxScoreResult, type KboGame } from "@/lib/crawler/kbo-api";
import { STANDINGS_ACCURACY_RULES, STANDINGS_UNAVAILABLE_RULES } from "@/lib/ai/standings-guard";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const PREVIEW_VERSION = 8; // v8: 순위 환각 방지 가드(공식 순위표 기준 규칙 + 조회 실패 fallback) — 기존 캐시 재생성

// Build a set of current roster players (teamShortName:playerName) for filtering, 부상자 제외.
const currentRosterSet = new Set<string>();
for (const p of playersRoster) {
  const team = TEAMS.find(t => t.id === p.teamId);
  if (!team) continue;
  const key = `${team.shortName}:${p.name}`;
  if (INJURY_BLOCKLIST_KEYS.has(key)) continue;
  currentRosterSet.add(key);
}

interface PreviewRequest {
  gameId: string;
  awayTeamId: number;
  homeTeamId: number;
  awayStarter?: string;
  homeStarter?: string;
}

interface PreviewAvailability {
  allowed: boolean;
  message?: string;
  availableFrom?: string;
}

function getTeamShortName(teamId: number): string {
  return TEAMS.find(t => t.id === teamId)?.shortName || `팀${teamId}`;
}

function getTeamName(teamId: number): string {
  return TEAMS.find(t => t.id === teamId)?.name || `팀${teamId}`;
}

/** 팀 주요 타자 스탯 (타율 상위 8명) - 현재 로스터에 있는 선수만 */
function getTeamBatters(teamId: number) {
  const teamName = getTeamShortName(teamId);
  return (batterStats as Array<{ name: string; team: string; avg: string; hr: number; rbi: number; hits: number; games: number; ob?: string; obp?: string; ops?: string }>)
    .filter(b => b.team === teamName && currentRosterSet.has(`${teamName}:${b.name}`))
    .sort((a, b) => parseFloat(b.avg) - parseFloat(a.avg))
    .slice(0, 8)
    .map(b => `${b.name} (타율 ${b.avg}, ${b.hr}홈런, ${b.rbi}타점, ${b.games}경기)`);
}

/** 팀 주요 투수 스탯 - 현재 로스터에 있는 선수만 */
function getTeamPitchers(teamId: number) {
  const teamName = getTeamShortName(teamId);
  return (pitcherStats as Array<{ name: string; team: string; era: string; wins: number; losses: number; saves: number; holds: number; ip: string; so: number; games: number; whip?: string }>)
    .filter(p => p.team === teamName && currentRosterSet.has(`${teamName}:${p.name}`))
    .sort((a, b) => parseFloat(a.era) - parseFloat(b.era))
    .slice(0, 6)
    .map(p => `${p.name} (ERA ${p.era}, ${p.wins}승${p.losses}패, ${p.saves}세이브, ${p.so}삼진, ${p.ip}이닝, ${p.games}경기)`);
}

/** 선발투수 상세 스탯 (static JSON → Supabase fallback) */
async function getStarterStats(name: string, teamId: number): Promise<string | null> {
  const teamName = getTeamShortName(teamId);
  // 1차: static JSON (빠름)
  const pitcher = (pitcherStats as Array<{ name: string; team: string; era: string; wins: number; losses: number; ip: string; so: number; games: number; whip?: string }>)
    .find(p => p.name === name && p.team === teamName);
  if (pitcher) {
    return `${pitcher.name}: ERA ${pitcher.era}, ${pitcher.wins}승${pitcher.losses}패, ${pitcher.ip}이닝, ${pitcher.so}삼진, ${pitcher.games}경기${pitcher.whip ? `, WHIP ${pitcher.whip}` : ""}`;
  }
  // 2차: Supabase player_stats_pitcher (런타임, cron이 수집한 데이터)
  try {
    const { data } = await supabase
      .from("player_stats_pitcher")
      .select("name, era, wins, losses, ip, so, games, whip")
      .eq("name", name)
      .eq("team", teamName)
      .single();
    if (data) {
      return `${data.name}: ERA ${data.era}, ${data.wins}승${data.losses}패, ${data.ip}이닝, ${data.so}삼진, ${data.games}경기${data.whip ? `, WHIP ${data.whip}` : ""}`;
    }
  } catch { /* Supabase 실패 시 graceful fallback */ }
  // 3차: 최근 box score 순회로 시즌 스탯 직접 계산 (누락 0 보장)
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    let games = 0, totalIP = 0, totalER = 0, totalK = 0, wins = 0, losses = 0;
    for (let offset = 1; offset <= 60 && games < 10; offset++) {
      const d = shiftDate(today, -offset);
      const dayGames = await fetchGames(d).catch(() => [] as KboGame[]);
      for (const g of dayGames) {
        if (g.status !== "final") continue;
        const isAway = g.awayTeamId === teamId;
        const isHome = g.homeTeamId === teamId;
        if (!isAway && !isHome) continue;
        const starter = isAway ? g.awayStarterName : g.homeStarterName;
        if (starter !== name) continue;
        const bs = await fetchBoxScore(g.gameId).catch(() => null);
        if (!bs) continue;
        const pitchers = isAway ? bs.awayPitchers : bs.homePitchers;
        const sp = pitchers[0];
        if (!sp || sp.name !== name) continue;
        games++;
        totalIP += parseIP(sp.inningsPitched);
        totalER += sp.earnedRuns;
        totalK += sp.strikeouts;
        if (sp.decision === "승") wins++;
        else if (sp.decision === "패") losses++;
      }
    }
    if (games > 0) {
      const era = totalIP > 0 ? ((totalER / totalIP) * 9).toFixed(2) : "0.00";
      return `${name}: ERA ${era}, ${wins}승${losses}패, ${totalIP.toFixed(1)}이닝, ${totalK}삼진, ${games}경기 (최근 box score 기준)`;
    }
  } catch { /* box score 순회 실패 시 graceful fallback */ }
  return null;
}

// ===== Runtime data helpers =====

interface SeriesContext {
  totalGames: number;
  awayWins: number;
  homeWins: number;
  gameResults: string[];
}

interface StandingsContext {
  awayRank: number;
  awayRecord: string;
  awayGb: number;
  homeRank: number;
  homeRecord: string;
  homeGb: number;
}

interface HotColdPlayer {
  name: string;
  summary: string;
}

interface RecentRecord {
  wins: number;
  losses: number;
  draws: number;
  results: string[];
}

interface HeadToHeadRecord {
  awayWins: number;
  homeWins: number;
  draws: number;
  results: string[];
}

interface LineupPlayer {
  order: number;
  position: string;
  name: string;
}

interface TodayLineup {
  batters: LineupPlayer[];
  startingPitcher: string;
}

interface LineupDiffSignal {
  newEntries: string[];
  removed: string[];
  keyOrderChanges: string[];
  catcherChanged: { from: string; to: string } | null;
}

/** gameId 앞 8자리에서 날짜 추출 → YYYYMMDD */
function getDateFromGameId(gameId: string): string {
  return gameId.slice(0, 8);
}

/** 날짜 +/- n일 (YYYYMMDD 형식) */
function shiftDate(dateStr: string, days: number): string {
  const y = parseInt(dateStr.slice(0, 4));
  const m = parseInt(dateStr.slice(4, 6)) - 1;
  const d = parseInt(dateStr.slice(6, 8));
  const dt = new Date(y, m, d + days);
  const yy = dt.getFullYear().toString();
  const mm = (dt.getMonth() + 1).toString().padStart(2, "0");
  const dd = dt.getDate().toString().padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// ===== KBO Lineup API =====

const KBO_BASE = "https://www.koreabaseball.com/ws/Schedule.asmx";
// 2026-05-20: KBO가 Referer가 koreabaseball.com이 아닌 요청을 IE 에러 페이지로 막음.
const KBO_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
  "Referer": "https://www.koreabaseball.com/Schedule/LineUp.aspx",
};

const POS_MAP: Record<string, string> = {
  "투수": "P", "포수": "C", "1루수": "1B", "2루수": "2B",
  "3루수": "3B", "유격수": "SS", "좌익수": "LF", "중견수": "CF",
  "우익수": "RF", "지명타자": "DH",
  "타지": "DH", "타좌": "LF", "타우": "RF", "타중": "CF",
  "타1": "1B", "타2": "2B", "타3": "3B", "타유": "SS", "타포": "C",
  "주좌": "LF", "주우": "RF", "주중": "CF", "주1": "1B", "주2": "2B", "주3": "3B", "주유": "SS",
  "대타": "DH", "대주": "DH",
};

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

function safeStr(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "&nbsp;" ? "" : s;
}

function safeInt(v: unknown): number {
  if (v == null || v === "" || v === "&nbsp;") return 0;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

function parseLineupRows(raw: unknown): LineupPlayer[] {
  let parsed: { rows: { row: { Text: string }[] }[] };
  try {
    const val = Array.isArray(raw) && raw.length > 0 ? raw[0] : raw;
    parsed = typeof val === "string" ? JSON.parse(val) : val;
  } catch {
    return [];
  }
  if (!parsed?.rows) return [];
  return parsed.rows.map(r => {
    const cells = r.row.map(c => safeStr(c.Text));
    const posKr = stripHtml(cells[1] || "");
    return {
      order: safeInt(cells[0]),
      position: POS_MAP[posKr] || posKr,
      name: stripHtml(cells[2] || ""),
    };
  }).filter(e => e.name !== "");
}

async function fetchTodayLineup(gameId: string, teamId: number, isAway: boolean): Promise<TodayLineup | null> {
  const seasonId = gameId.slice(0, 4);
  const reqBody = `leId=1&srId=0&seasonId=${seasonId}&gameId=${gameId}`;
  try {
    const res = await fetch(`${KBO_BASE}/GetLineUpAnalysis`, {
      method: "POST",
      headers: KBO_HEADERS,
      body: reqBody,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 5) return null;
    const batters = parseLineupRows(isAway ? data[4] : data[3]);
    if (batters.length === 0) return null;
    return { batters, startingPitcher: "" };
  } catch {
    return null;
  }
}

async function fetchPrevGameLineup(gameId: string, teamId: number): Promise<LineupPlayer[] | null> {
  const dateStr = getDateFromGameId(gameId);
  const MAX_LOOKBACK = 5;
  for (let offset = 1; offset <= MAX_LOOKBACK; offset++) {
    const d = shiftDate(dateStr, -offset);
    const games = await fetchGames(d).catch(() => [] as KboGame[]);
    const teamGames = games.filter(
      g => g.status === "final" && g.gameId !== gameId && (g.awayTeamId === teamId || g.homeTeamId === teamId)
    );
    const teamGame = teamGames.length > 0 ? teamGames[teamGames.length - 1] : null;
    if (!teamGame) continue;
    const isAway = teamGame.awayTeamId === teamId;
    const seasonId = teamGame.gameId.slice(0, 4);
    const reqBody = `leId=1&srId=0&seasonId=${seasonId}&gameId=${teamGame.gameId}`;
    try {
      const res = await fetch(`${KBO_BASE}/GetLineUpAnalysis`, {
        method: "POST",
        headers: KBO_HEADERS,
        body: reqBody,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data) || data.length < 5) continue;
      const batters = parseLineupRows(isAway ? data[4] : data[3]);
      if (batters.length > 0) return batters;
    } catch {
      continue;
    }
  }
  return null;
}

function computeLineupDiff(today: LineupPlayer[], prev: LineupPlayer[]): LineupDiffSignal {
  const todayNames = new Set(today.map(b => b.name));
  const prevNames = new Set(prev.map(b => b.name));
  const prevMap = new Map(prev.map(b => [b.name, b]));
  const todayMap = new Map(today.map(b => [b.name, b]));

  const newEntries = [...todayNames].filter(n => !prevNames.has(n));
  const removed = [...prevNames].filter(n => !todayNames.has(n));

  const keyOrderChanges: string[] = [];
  for (const name of todayNames) {
    if (!prevNames.has(name)) continue;
    const p = prevMap.get(name)!;
    const c = todayMap.get(name)!;
    if (p.order !== c.order && (p.order <= 5 || c.order <= 5)) {
      keyOrderChanges.push(`${name} ${p.order}번→${c.order}번`);
    }
  }

  const prevCatcher = prev.find(b => b.position === "C");
  const todayCatcher = today.find(b => b.position === "C");
  const catcherChanged = (prevCatcher && todayCatcher && prevCatcher.name !== todayCatcher.name)
    ? { from: prevCatcher.name, to: todayCatcher.name }
    : null;

  return { newEntries, removed, keyOrderChanges, catcherChanged };
}

// ===== Recent Record & Head-to-Head =====

async function getRecentTeamRecord(gameId: string, teamId: number, count = 5): Promise<RecentRecord> {
  const dateStr = getDateFromGameId(gameId);
  const MAX_LOOKBACK = 15;
  const record: RecentRecord = { wins: 0, losses: 0, draws: 0, results: [] };

  for (let offset = 1; offset <= MAX_LOOKBACK && record.results.length < count; offset++) {
    const d = shiftDate(dateStr, -offset);
    const games = await fetchGames(d).catch(() => [] as KboGame[]);
    const teamGames = games.filter(
      g => g.status === "final" && (g.awayTeamId === teamId || g.homeTeamId === teamId)
    );
    teamGames.sort((a, b) => b.time.localeCompare(a.time));
    for (const g of teamGames) {
      if (record.results.length >= count) break;
      const isAway = g.awayTeamId === teamId;
      const myScore = isAway ? (g.awayScore ?? 0) : (g.homeScore ?? 0);
      const oppScore = isAway ? (g.homeScore ?? 0) : (g.awayScore ?? 0);
      const oppName = isAway ? getTeamShortName(g.homeTeamId) : getTeamShortName(g.awayTeamId);
      if (myScore > oppScore) {
        record.wins++;
        record.results.push(`W ${myScore}-${oppScore} vs ${oppName}`);
      } else if (myScore < oppScore) {
        record.losses++;
        record.results.push(`L ${myScore}-${oppScore} vs ${oppName}`);
      } else {
        record.draws++;
        record.results.push(`D ${myScore}-${oppScore} vs ${oppName}`);
      }
    }
  }
  return record;
}

interface StarterVsOpponent {
  games: number;
  wins: number;
  losses: number;
  totalIP: number;
  totalER: number;
  totalK: number;
  era: string; // calculated
  summary: string;
}

/** 선발투수의 상대팀 대상 최근 등판 기록 */
async function getStarterVsOpponent(
  gameId: string,
  starterName: string,
  starterTeamId: number,
  opponentTeamId: number,
): Promise<StarterVsOpponent | null> {
  const dateStr = getDateFromGameId(gameId);
  const MAX_LOOKBACK = 90;
  const MAX_GAMES = 5;

  let games = 0, wins = 0, losses = 0, totalIP = 0, totalER = 0, totalK = 0;
  const gameDetails: string[] = [];

  for (let offset = 1; offset <= MAX_LOOKBACK && games < MAX_GAMES; offset++) {
    const d = shiftDate(dateStr, -offset);
    const dayGames = await fetchGames(d).catch(() => [] as KboGame[]);
    // 해당 투수가 선발로 나온 상대팀 경기만 필터
    const matchups = dayGames.filter(g => {
      if (g.status !== "final") return false;
      const isAway = g.awayTeamId === starterTeamId;
      const isHome = g.homeTeamId === starterTeamId;
      if (!isAway && !isHome) return false;
      const oppId = isAway ? g.homeTeamId : g.awayTeamId;
      if (oppId !== opponentTeamId) return false;
      const starter = isAway ? g.awayStarterName : g.homeStarterName;
      return starter === starterName;
    });

    for (const g of matchups) {
      if (games >= MAX_GAMES) break;
      const bs = await fetchBoxScore(g.gameId).catch(() => null);
      if (!bs) continue;
      const isAway = g.awayTeamId === starterTeamId;
      const pitchers = isAway ? bs.awayPitchers : bs.homePitchers;
      // 선발투수는 첫 번째 투수
      const sp = pitchers[0];
      if (!sp || sp.name !== starterName) continue;

      games++;
      const ip = parseIP(sp.inningsPitched);
      totalIP += ip;
      totalER += sp.earnedRuns;
      totalK += sp.strikeouts;
      if (sp.decision === "승") wins++;
      else if (sp.decision === "패") losses++;

      const dateLabel = `${d.slice(4, 6)}/${d.slice(6, 8)}`;
      const oppShort = getTeamShortName(opponentTeamId);
      gameDetails.push(`${dateLabel} vs ${oppShort}: ${sp.inningsPitched}이닝 ${sp.earnedRuns}자책 ${sp.strikeouts}K (${sp.decision || "ND"})`);
    }
  }

  if (games === 0) return null;

  const era = totalIP > 0 ? ((totalER / totalIP) * 9).toFixed(2) : "0.00";
  const oppShort = getTeamShortName(opponentTeamId);
  const summary = `vs ${oppShort} 최근 ${games}등판: ERA ${era}, ${wins}승${losses}패, ${totalK}K / ${gameDetails.join(" | ")}`;

  return { games, wins, losses, totalIP, totalER, totalK, era, summary };
}

/** 이닝 문자열 파싱 ("5 2/3" → 5.667) */
function parseIP(ip: string): number {
  const parts = ip.trim().split(/\s+/);
  let total = 0;
  if (parts[0]) total += parseInt(parts[0], 10) || 0;
  if (parts[1]) {
    const frac = parts[1].split("/");
    if (frac.length === 2) total += (parseInt(frac[0], 10) || 0) / (parseInt(frac[1], 10) || 1);
  }
  // Handle "5.1" or "5.2" format (KBO style: .1 = 1/3, .2 = 2/3)
  if (parts.length === 1 && ip.includes(".")) {
    const [whole, dec] = ip.split(".");
    total = (parseInt(whole, 10) || 0) + (parseInt(dec, 10) || 0) / 3;
  }
  return total;
}

async function getHeadToHead(gameId: string, awayTeamId: number, homeTeamId: number): Promise<HeadToHeadRecord> {
  const dateStr = getDateFromGameId(gameId);
  const seasonYear = dateStr.slice(0, 4); // 같은 시즌만 필터
  const MAX_LOOKBACK = 200; // 시즌 전체 커버 (3월 말~10월)
  const h2h: HeadToHeadRecord = { awayWins: 0, homeWins: 0, draws: 0, results: [] };

  for (let offset = 1; offset <= MAX_LOOKBACK; offset++) {
    const d = shiftDate(dateStr, -offset);
    // 전시즌 도달하면 중단
    if (d.slice(0, 4) !== seasonYear) break;
    const games = await fetchGames(d).catch(() => [] as KboGame[]);
    const matchups = games.filter(
      g => g.status === "final" &&
        ((g.awayTeamId === awayTeamId && g.homeTeamId === homeTeamId) ||
         (g.awayTeamId === homeTeamId && g.homeTeamId === awayTeamId))
    );
    for (const g of matchups) {
      const aScore = g.awayScore ?? 0;
      const hScore = g.homeScore ?? 0;
      const dateLabel = `${d.slice(4, 6)}/${d.slice(6, 8)}`;
      const awayIsOurAway = g.awayTeamId === awayTeamId;
      if (awayIsOurAway) {
        if (aScore > hScore) h2h.awayWins++;
        else if (hScore > aScore) h2h.homeWins++;
        else h2h.draws++;
      } else {
        if (aScore > hScore) h2h.homeWins++;
        else if (hScore > aScore) h2h.awayWins++;
        else h2h.draws++;
      }
      h2h.results.push(`${dateLabel} ${getTeamShortName(g.awayTeamId)} ${aScore}-${hScore} ${getTeamShortName(g.homeTeamId)}`);
    }
  }
  return h2h;
}

/** 3연전(시리즈) 맥락 추출 — 전후 1~2일 경기에서 같은 팀 대결 찾기 */
async function getSeriesContext(gameId: string, awayTeamId: number, homeTeamId: number): Promise<SeriesContext | null> {
  const dateStr = getDateFromGameId(gameId);
  const dates = [shiftDate(dateStr, -2), shiftDate(dateStr, -1), shiftDate(dateStr, 1)];
  const allGames = await Promise.all(dates.map(d => fetchGames(d).catch(() => [])));
  const flat = allGames.flat();

  const seriesGames = flat.filter(g =>
    g.gameId !== gameId &&
    ((g.awayTeamId === awayTeamId && g.homeTeamId === homeTeamId) ||
     (g.awayTeamId === homeTeamId && g.homeTeamId === awayTeamId))
  );

  if (seriesGames.length === 0) return null;

  let awayWins = 0;
  let homeWins = 0;
  const gameResults: string[] = [];

  for (const g of seriesGames) {
    if (g.status !== "final") continue;
    const aScore = g.awayScore ?? 0;
    const hScore = g.homeScore ?? 0;
    // Determine winner relative to our away/home
    if (g.awayTeamId === awayTeamId) {
      if (aScore > hScore) awayWins++;
      else if (hScore > aScore) homeWins++;
      gameResults.push(`${g.date}: ${g.awayName} ${aScore} - ${hScore} ${g.homeName}`);
    } else {
      if (aScore > hScore) homeWins++;
      else if (hScore > aScore) awayWins++;
      gameResults.push(`${g.date}: ${g.awayName} ${aScore} - ${hScore} ${g.homeName}`);
    }
  }

  return {
    totalGames: seriesGames.length + 1, // including today
    awayWins,
    homeWins,
    gameResults,
  };
}

/** 순위표에서 양 팀 정보 추출 */
async function getStandingsContext(awayTeamId: number, homeTeamId: number): Promise<StandingsContext | null> {
  const standings = await fetchStandings();
  if (standings.length === 0) return null;

  const awayName = getTeamShortName(awayTeamId);
  const homeName = getTeamShortName(homeTeamId);

  const awaySt = standings.find(s => s.teamName === awayName);
  const homeSt = standings.find(s => s.teamName === homeName);

  if (!awaySt || !homeSt) return null;

  // 공동순위 보존 — 원본 ranking 우선(buildRankMap), index+1 단순 방식 금지(삼순 조건)
  const rankMap = buildRankMap(standings);
  const awayRank = rankMap.get(awaySt.teamId) ?? awaySt.ranking ?? 0;
  const homeRank = rankMap.get(homeSt.teamId) ?? homeSt.ranking ?? 0;

  return {
    awayRank,
    awayRecord: `${awaySt.wins}승 ${awaySt.losses}패 ${awaySt.draws}무 (승률 ${awaySt.winRate.toFixed(3)})`,
    awayGb: awaySt.gamesBehind,
    homeRank,
    homeRecord: `${homeSt.wins}승 ${homeSt.losses}패 ${homeSt.draws}무 (승률 ${homeSt.winRate.toFixed(3)})`,
    homeGb: homeSt.gamesBehind,
  };
}

/** 최근 3~4경기 BoxScore에서 Hot/Cold 선수 추출 (경기 수 기준, 최대 10일 역추적) */
async function getRecentForm(gameId: string, teamId: number): Promise<HotColdPlayer[]> {
  const dateStr = getDateFromGameId(gameId);
  const teamShortName = getTeamShortName(teamId);
  const TARGET_GAMES = 4;
  const MAX_LOOKBACK_DAYS = 10;

  // 경기 수 기준으로 역추적 (우천취소/휴식일 대응)
  const teamGames: KboGame[] = [];
  for (let dayOffset = 1; dayOffset <= MAX_LOOKBACK_DAYS && teamGames.length < TARGET_GAMES; dayOffset++) {
    const d = shiftDate(dateStr, -dayOffset);
    const games = await fetchGames(d).catch(() => []);
    const matching = games.filter(g =>
      g.status === "final" &&
      (g.awayTeamId === teamId || g.homeTeamId === teamId)
    );
    teamGames.push(...matching);
  }

  // 최대 4경기만
  const recentGames = teamGames.slice(0, TARGET_GAMES);
  if (recentGames.length === 0) return [];

  // BoxScore 병렬 조회
  const boxScores = await Promise.all(
    recentGames.map(g => fetchBoxScore(g.gameId).catch(() => null))
  );

  // 타자 성적 집계
  const batterMap = new Map<string, { hits: number; atBats: number; hr: number; rbi: number; games: number }>();

  for (let i = 0; i < recentGames.length; i++) {
    const bs = boxScores[i];
    if (!bs) continue;
    const batters = recentGames[i].awayTeamId === teamId ? bs.awayBatters : bs.homeBatters;
    for (const b of batters) {
      if (b.atBats === 0) continue;
      // 현재 로스터 필터 — 부상/말소 선수 제외
      if (!currentRosterSet.has(`${teamShortName}:${b.name}`)) continue;
      const prev = batterMap.get(b.name) || { hits: 0, atBats: 0, hr: 0, rbi: 0, games: 0 };
      prev.hits += b.hits;
      prev.atBats += b.atBats;
      prev.hr += b.hr;
      prev.rbi += b.rbi;
      prev.games += 1;
      batterMap.set(b.name, prev);
    }
  }

  // Hot 선수: 최근 타율 .350+ (최소 2경기)
  const hotPlayers: HotColdPlayer[] = [];
  for (const [name, stats] of batterMap) {
    if (stats.games < 2 || stats.atBats < 5) continue;
    const recentAvg = stats.hits / stats.atBats;
    if (recentAvg >= 0.350) {
      hotPlayers.push({
        name,
        summary: `최근 ${stats.games}경기 ${stats.atBats}타수 ${stats.hits}안타 (${recentAvg.toFixed(3)})${stats.hr > 0 ? ` ${stats.hr}홈런` : ""}${stats.rbi > 0 ? ` ${stats.rbi}타점` : ""}`,
      });
    }
  }

  // 상위 3명만
  return hotPlayers
    .sort((a, b) => {
      const aStats = batterMap.get(a.name)!;
      const bStats = batterMap.get(b.name)!;
      return (bStats.hits / bStats.atBats) - (aStats.hits / aStats.atBats);
    })
    .slice(0, 3);
}

/** 라인업 선수에 시즌 스탯 붙이기 */
function enrichLineupWithStats(batters: LineupPlayer[], teamId: number): string[] {
  const teamName = getTeamShortName(teamId);
  const statsMap = new Map(
    (batterStats as Array<{ name: string; team: string; avg: string; hr: number; rbi: number; games: number }>)
      .filter(b => b.team === teamName)
      .map(b => [b.name, b])
  );
  return batters.map(b => {
    const s = statsMap.get(b.name);
    if (s) {
      return `${b.order}번 ${b.position} ${b.name} (타율 ${s.avg}, ${s.hr}홈런, ${s.rbi}타점, ${s.games}경기)`;
    }
    return `${b.order}번 ${b.position} ${b.name}`;
  });
}

/** diff 시그널을 프롬프트용 텍스트로 포맷 */
function formatDiffSignal(diff: LineupDiffSignal, teamShort: string): string {
  const parts: string[] = [];
  if (diff.newEntries.length > 0) parts.push(`신규 합류: ${diff.newEntries.join(", ")}`);
  if (diff.removed.length > 0) parts.push(`제외: ${diff.removed.join(", ")}`);
  if (diff.keyOrderChanges.length > 0) parts.push(`타순 변경: ${diff.keyOrderChanges.join(", ")}`);
  if (diff.catcherChanged) parts.push(`포수 변경: ${diff.catcherChanged.from} → ${diff.catcherChanged.to}`);
  if (parts.length === 0) return "";
  return `${teamShort}: ${parts.join(" / ")}\n`;
}

async function buildPreviewPrompt(req: PreviewRequest): Promise<string> {
  const awayShort = getTeamShortName(req.awayTeamId);
  const homeShort = getTeamShortName(req.homeTeamId);
  const awayName = getTeamName(req.awayTeamId);
  const homeName = getTeamName(req.homeTeamId);

  const awayBatters = getTeamBatters(req.awayTeamId);
  const homeBatters = getTeamBatters(req.homeTeamId);
  const awayPitchers = getTeamPitchers(req.awayTeamId);
  const homePitchers = getTeamPitchers(req.homeTeamId);

  const [awayStarterInfo, homeStarterInfo] = await Promise.all([
    req.awayStarter ? getStarterStats(req.awayStarter, req.awayTeamId) : null,
    req.homeStarter ? getStarterStats(req.homeStarter, req.homeTeamId) : null,
  ]);

  // 런타임 데이터 병렬 조회 (모두 try-catch로 감싸서 실패해도 기존 동작 유지)
  const [seriesCtx, standingsCtx, awayHotPlayers, homeHotPlayers,
    awayLineup, homeLineup, awayPrevLineup, homePrevLineup,
    awayRecentRecord, homeRecentRecord, h2hRecord,
    awayStarterVsOpp, homeStarterVsOpp] = await Promise.all([
    getSeriesContext(req.gameId, req.awayTeamId, req.homeTeamId).catch(() => null),
    getStandingsContext(req.awayTeamId, req.homeTeamId).catch(() => null),
    getRecentForm(req.gameId, req.awayTeamId).catch(() => []),
    getRecentForm(req.gameId, req.homeTeamId).catch(() => []),
    fetchTodayLineup(req.gameId, req.awayTeamId, true).catch(() => null),
    fetchTodayLineup(req.gameId, req.homeTeamId, false).catch(() => null),
    fetchPrevGameLineup(req.gameId, req.awayTeamId).catch(() => null),
    fetchPrevGameLineup(req.gameId, req.homeTeamId).catch(() => null),
    getRecentTeamRecord(req.gameId, req.awayTeamId).catch(() => ({ wins: 0, losses: 0, draws: 0, results: [] as string[] })),
    getRecentTeamRecord(req.gameId, req.homeTeamId).catch(() => ({ wins: 0, losses: 0, draws: 0, results: [] as string[] })),
    getHeadToHead(req.gameId, req.awayTeamId, req.homeTeamId).catch(() => ({ awayWins: 0, homeWins: 0, draws: 0, results: [] as string[] })),
    req.awayStarter ? getStarterVsOpponent(req.gameId, req.awayStarter, req.awayTeamId, req.homeTeamId).catch(() => null) : Promise.resolve(null),
    req.homeStarter ? getStarterVsOpponent(req.gameId, req.homeStarter, req.homeTeamId, req.awayTeamId).catch(() => null) : Promise.resolve(null),
  ]);

  // 오늘 실제 라인업 섹션
  let todayLineupSection = "";
  if (awayLineup && awayLineup.batters.length > 0) {
    const enriched = enrichLineupWithStats(awayLineup.batters, req.awayTeamId);
    todayLineupSection += `\n## ${awayShort} 오늘 선발 라인업\n${enriched.join("\n")}`;
  }
  if (homeLineup && homeLineup.batters.length > 0) {
    const enriched = enrichLineupWithStats(homeLineup.batters, req.homeTeamId);
    todayLineupSection += `\n## ${homeShort} 오늘 선발 라인업\n${enriched.join("\n")}`;
  }

  // 라인업 diff 시그널
  let lineupDiffSection = "";
  if (awayLineup && awayPrevLineup) {
    const diff = computeLineupDiff(awayLineup.batters, awayPrevLineup);
    const diffText = formatDiffSignal(diff, awayShort);
    if (diffText) lineupDiffSection += diffText;
  }
  if (homeLineup && homePrevLineup) {
    const diff = computeLineupDiff(homeLineup.batters, homePrevLineup);
    const diffText = formatDiffSignal(diff, homeShort);
    if (diffText) lineupDiffSection += diffText;
  }
  if (lineupDiffSection) {
    lineupDiffSection = `\n## 라인업 변경 시그널 (직전 경기 대비)\n${lineupDiffSection}`;
  }

  // 최근 5경기 팀 전적
  let recentRecordSection = "";
  if (awayRecentRecord.results.length > 0 || homeRecentRecord.results.length > 0) {
    recentRecordSection = `\n## 최근 5경기 팀 전적`;
    if (awayRecentRecord.results.length > 0) {
      recentRecordSection += `\n${awayShort}: ${awayRecentRecord.wins}승 ${awayRecentRecord.losses}패${awayRecentRecord.draws > 0 ? ` ${awayRecentRecord.draws}무` : ""} — ${awayRecentRecord.results.join(", ")}`;
    }
    if (homeRecentRecord.results.length > 0) {
      recentRecordSection += `\n${homeShort}: ${homeRecentRecord.wins}승 ${homeRecentRecord.losses}패${homeRecentRecord.draws > 0 ? ` ${homeRecentRecord.draws}무` : ""} — ${homeRecentRecord.results.join(", ")}`;
    }
  }

  // 시즌 상대전적
  let h2hSection = "";
  const totalH2h = h2hRecord.awayWins + h2hRecord.homeWins + h2hRecord.draws;
  if (totalH2h > 0) {
    h2hSection = `\n## 시즌 상대전적\n${awayShort} ${h2hRecord.awayWins}승 vs ${homeShort} ${h2hRecord.homeWins}승${h2hRecord.draws > 0 ? ` (${h2hRecord.draws}무)` : ""}\n${h2hRecord.results.join(", ")}`;
  }

  // 순위 & 시리즈 섹션 빌드 — 순위 데이터 없으면 순위 서술 금지 규칙으로 대체(환각 방지)
  let standingsSection = "";
  if (standingsCtx) {
    standingsSection = `
## 순위 & 시즌 성적
${awayShort}: ${standingsCtx.awayRank}위 — ${standingsCtx.awayRecord}${standingsCtx.awayRank === 1 ? " (선두)" : ` (${standingsCtx.awayGb}게임차)`}
${homeShort}: ${standingsCtx.homeRank}위 — ${standingsCtx.homeRecord}${standingsCtx.homeRank === 1 ? " (선두)" : ` (${standingsCtx.homeGb}게임차)`}
${STANDINGS_ACCURACY_RULES}`;
  } else {
    standingsSection = `
${STANDINGS_UNAVAILABLE_RULES}`;
  }

  let seriesSection = "";
  if (seriesCtx) {
    seriesSection = `
## 시리즈 맥락
${seriesCtx.totalGames}연전 중 — ${awayShort} ${seriesCtx.awayWins}승, ${homeShort} ${seriesCtx.homeWins}승
${seriesCtx.gameResults.length > 0 ? "이전 결과:\n" + seriesCtx.gameResults.join("\n") : ""}`;
  }

  let recentFormSection = "";
  if (awayHotPlayers.length > 0 || homeHotPlayers.length > 0) {
    recentFormSection = `
## 최근 폼 (Hot Players)`;
    if (awayHotPlayers.length > 0) {
      recentFormSection += `\n${awayShort}:\n${awayHotPlayers.map(p => `- ${p.name}: ${p.summary}`).join("\n")}`;
    }
    if (homeHotPlayers.length > 0) {
      recentFormSection += `\n${homeShort}:\n${homeHotPlayers.map(p => `- ${p.name}: ${p.summary}`).join("\n")}`;
    }
  }

  return `당신은 20년 경력의 KBO 프로야구 전문 기자입니다. 오늘 예정된 경기의 프리뷰를 작성하세요.
단순 템플릿이 아니라, 두 팀의 실제 스탯과 선수 특성을 비교분석한 고유한 내용이어야 합니다.

## 경기 정보
${awayShort} ${awayName} vs ${homeShort} ${homeName}
${req.awayStarter ? `원정 선발: ${req.awayStarter}` : "원정 선발: 미정"}
${req.homeStarter ? `홈 선발: ${req.homeStarter}` : "홈 선발: 미정"}

## ${awayShort} 선발투수 상세
${awayStarterInfo || `${req.awayStarter}: 2026 시즌 세부 스탯 미등록 (선발 확정)`}${awayStarterVsOpp ? `\n상대팀 등판 기록: ${awayStarterVsOpp.summary}` : ""}

## ${homeShort} 선발투수 상세
${homeStarterInfo || `${req.homeStarter}: 2026 시즌 세부 스탯 미등록 (선발 확정)`}${homeStarterVsOpp ? `\n상대팀 등판 기록: ${homeStarterVsOpp.summary}` : ""}
${todayLineupSection}${lineupDiffSection}${!(awayLineup && awayLineup.batters.length > 0) ? `
## ${awayShort} 주요 타자 (2026 시즌 기록)
${awayBatters.join("\n")}` : ""}${!(homeLineup && homeLineup.batters.length > 0) ? `
## ${homeShort} 주요 타자 (2026 시즌 기록)
${homeBatters.join("\n")}` : ""}

## ${awayShort} 투수진 (2026 시즌 기록)
${awayPitchers.join("\n")}

## ${homeShort} 투수진 (2026 시즌 기록)
${homePitchers.join("\n")}
${standingsSection}${seriesSection}${recentRecordSection}${h2hSection}${recentFormSection}

## 작성 규칙
0. 존댓말(~습니다/~합니다) 절대 금지. 기사체 반말(~했다/~이다/~있다)로만 작성하세요.
1. 반드시 위에 제공된 실제 스탯만 사용. 없는 수치를 만들지 마세요.
2. 두 팀의 장단점을 구체적 수치와 함께 비교 분석하세요.
3. 선발투수의 스타일과 상대 타선의 매치업을 분석하세요.
4. 승률 예측 근거 4대 팩터를 종합 고려: ①오늘 실제 라인업 ②팀 최근 5경기 흐름 ③시즌 상대전적 ④선발투수 상대팀 등판 기록. 어느 하나도 단독 결정요인으로 쓰지 말고 복합적으로 판단하세요.
5. 핵심 포인트는 이 경기만의 고유한 이야기를 담으세요 (선수 간 대결, 기록 도전 등).
6. "오늘 선발 라인업" 정보가 있으면, 오늘 실제 출전 선수 중심으로 분석. keyPlayers는 오늘 실제 출전 핵심선수(타자: 선발 라인업 내, 투수: 선발투수 포함 허용).
7. 라인업 변경 시그널이 있으면, 예측 근거에 활용 (신규 합류/제외 선수가 전력에 미치는 영향).
8. 한국어로 작성.

## 출력 형식 (JSON만 출력)
{
  "awayWinPct": 숫자(35~65 사이, 소수점 없음),
  "homeWinPct": 숫자(100 - awayWinPct),
  "prediction": "한 줄 예측 요약 (예: 'LG 52% 우세 (임찬규의 안정적 ERA + 오스틴 딘 핫스트릭)')",
  "keyMatchup": "3~5문장의 핵심 매치업 분석. 선발투수 vs 타선 구도, 승리 조건, 주목 포인트를 구체적으로.",
  "awayStrengths": ["강점1", "강점2", "강점3"],
  "awayWeaknesses": ["약점1", "약점2"],
  "homeStrengths": ["강점1", "강점2", "강점3"],
  "homeWeaknesses": ["약점1", "약점2"],
  "awayKeyPlayers": [{"name": "선수명", "reason": "왜 키플레이어인지 1~2문장"}],
  "homeKeyPlayers": [{"name": "선수명", "reason": "왜 키플레이어인지 1~2문장"}],
  "seriesContext": "3연전 맥락 요약 (없으면 null)",
  "standingsImpact": "순위 영향 분석 (예: '4위 싸움에서 중요한 경기') (없으면 null)",
  "hotPlayers": ["핫플레이어1 요약", "핫플레이어2 요약"]
}`;
}

function cacheKey(gameId: string) {
  return `preview_${gameId}`; // no version suffix
}

async function getCached(gameId: string): Promise<{ summary: Record<string, unknown>; outdated: boolean } | null> {
  try {
    const { data } = await supabase
      .from("game_summaries")
      .select("summary, prompt_version")
      .eq("game_id", cacheKey(gameId))
      .single();
    if (!data?.summary) return null;
    const outdated = (data.prompt_version ?? 0) < PREVIEW_VERSION;
    return { summary: data.summary as Record<string, unknown>, outdated };
  } catch {
    return null;
  }
}


async function getGame(gameId: string): Promise<KboGame | null> {
  try {
    const dateStr = getDateFromGameId(gameId);
    const games = await fetchGames(dateStr);
    return games.find(g => g.gameId === gameId) ?? null;
  } catch {
    return null;
  }
}

async function getGameStatus(gameId: string): Promise<KboGame["status"] | null> {
  const game = await getGame(gameId);
  return game?.status ?? null;
}

function formatKstIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:00+09:00`;
}

function parseKstGameDateTime(game: KboGame): Date | null {
  const dateMatch = game.date.match(/^(\d{4})(\d{2})(\d{2})$/);
  const timeMatch = game.time.match(/^(\d{1,2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;

  const [, year, month, day] = dateMatch;
  const [, hour, minute] = timeMatch;
  return new Date(`${year}-${month}-${day}T${hour.padStart(2, "0")}:${minute}:00+09:00`);
}

async function getPreviewAvailability(gameId: string): Promise<PreviewAvailability> {
  const game = await getGame(gameId);
  if (!game) return { allowed: true };
  if (game.status !== "scheduled") return { allowed: true };

  const gameStart = parseKstGameDateTime(game);
  if (!gameStart) return { allowed: true };

  const availableAt = new Date(gameStart.getTime() - 12 * 60 * 60 * 1000);
  const now = new Date();

  if (now < availableAt) {
    return {
      allowed: false,
      message: "경기 12시간 전부터 AI 경기 예측 조회가 가능합니다.",
      availableFrom: formatKstIso(availableAt),
    };
  }

  return { allowed: true, availableFrom: formatKstIso(availableAt) };
}

async function saveCache(gameId: string, summary: Record<string, unknown>) {
  try {
    await supabase
      .from("game_summaries")
      .upsert(
        { game_id: cacheKey(gameId), summary, prompt_version: PREVIEW_VERSION, created_at: new Date().toISOString() },
        { onConflict: "game_id" }
      );
  } catch { /* ignore */ }
}

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "gameId required" }, { status: 400 });
  if (isAllStarGameId(gameId)) return NextResponse.json({ preview: null, source: "allstar" });

  const status = await getGameStatus(gameId);
  if (status === "cancelled") {
    return NextResponse.json({ preview: null, source: "cancelled" });
  }

  const availability = await getPreviewAvailability(gameId);
  if (!availability.allowed) {
    return NextResponse.json({
      preview: null,
      source: "too_early",
      message: availability.message,
      availableFrom: availability.availableFrom,
    });
  }

  const cached = await getCached(gameId);
  if (cached) {
    return NextResponse.json({ preview: cached.summary, source: "cache", outdated: cached.outdated, availableFrom: availability.availableFrom });
  }
  return NextResponse.json({ preview: null, source: "none", availableFrom: availability.availableFrom });
}

export async function POST(req: NextRequest) {
  const body: PreviewRequest = await req.json();
  if (!body.gameId || !body.awayTeamId || !body.homeTeamId) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  if (isAllStarGameId(body.gameId) || isAllStarGame(body.awayTeamId, body.homeTeamId)) {
    return NextResponse.json({ preview: null, source: "allstar" });
  }
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
  }

  const status = await getGameStatus(body.gameId);
  if (status === "cancelled") {
    return NextResponse.json({ preview: null, source: "cancelled" });
  }

  const availability = await getPreviewAvailability(body.gameId);
  if (!availability.allowed) {
    return NextResponse.json({
      preview: null,
      source: "too_early",
      message: availability.message,
      availableFrom: availability.availableFrom,
    });
  }

  // 선발투수가 없으면 fetchGames로 오늘 경기에서 선발투수 조회
  if (!body.awayStarter || !body.homeStarter) {
    try {
      const dateStr = getDateFromGameId(body.gameId);
      const todayGames = await fetchGames(dateStr);
      const thisGame = todayGames.find(g => g.gameId === body.gameId);
      if (thisGame) {
        if (!body.awayStarter && thisGame.awayStarterName) body.awayStarter = thisGame.awayStarterName;
        if (!body.homeStarter && thisGame.homeStarterName) body.homeStarter = thisGame.homeStarterName;
      }
    } catch { /* graceful fallback — proceed without starters */ }
  }

  // 캐시 확인
  const cached = await getCached(body.gameId);
  if (cached && !cached.outdated) {
    return NextResponse.json({ preview: cached.summary, source: "cache" });
  }

  try {
    const prompt = await buildPreviewPrompt(body);

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini preview error:", geminiRes.status, errText);
      return NextResponse.json({ error: "Gemini API failed" }, { status: 502 });
    }

    const geminiData = await geminiRes.json();
    const parts = geminiData.candidates?.[0]?.content?.parts ?? [];
    const textParts = parts.filter((p: { text?: string }) => p.text);
    const rawText = textParts.length > 0 ? textParts[textParts.length - 1].text : null;

    if (!rawText) {
      return NextResponse.json({ error: "Empty Gemini response" }, { status: 502 });
    }

    let preview;
    try {
      preview = JSON.parse(rawText);
    } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { preview = JSON.parse(jsonMatch[0]); }
        catch { return NextResponse.json({ error: "Invalid response format" }, { status: 502 }); }
      } else {
        return NextResponse.json({ error: "Invalid response format" }, { status: 502 });
      }
    }

    await saveCache(body.gameId, preview);
    return NextResponse.json({ preview, source: "generated" });
  } catch (err) {
    console.error("Game preview generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
