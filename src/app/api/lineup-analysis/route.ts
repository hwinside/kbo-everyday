import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { fetchGames, type KboGame } from "@/lib/crawler/kbo-api";
import { TEAMS } from "@/lib/constants/teams";
import pitcherStats from "@/lib/constants/stats-2026-pitchers.json";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const ANALYSIS_VERSION = 6;

const KBO_BASE = "https://www.koreabaseball.com/ws/Schedule.asmx";
// 2026-05-20: KBO가 Referer가 koreabaseball.com이 아닌 요청을 IE 에러 페이지로 막음.
const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
  "Referer": "https://www.koreabaseball.com/Schedule/LineUp.aspx",
};

interface LineupPlayer {
  order: number;
  position: string;
  name: string;
}

interface LineupRequest {
  gameId: string;
  awayTeamId: number;
  homeTeamId: number;
  // KBO LINEUP_CK=true일 때만 true. false면 fallback 라인업일 가능성 높으므로 거부.
  isLineupConfirmed?: boolean;
  lineup: {
    away: {
      startingPitcher: string;
      // 진짜 ERA (카드 상단과 동일 소스, KBO API 박스스코어/통산). 제공되면 이 값 우선.
      startingPitcherEra?: string;
      catcher: string;
      batters: LineupPlayer[];
    };
    home: {
      startingPitcher: string;
      startingPitcherEra?: string;
      catcher: string;
      batters: LineupPlayer[];
    };
  };
}

interface LineupDiffSide {
  teamName: string;
  starterChanged: { from: string; to: string } | null;
  catcherChanged: { from: string; to: string } | null;
  newEntries: string[];
  removed: string[];
  orderChanges: { name: string; from: number; to: number }[];
  positionChanges: { name: string; from: string; to: string }[];
}

interface LineupDiff {
  away: LineupDiffSide;
  home: LineupDiffSide;
  hasDiff: boolean;
}

function getTeamShortName(teamId: number): string {
  return TEAMS.find(t => t.id === teamId)?.shortName || `팀${teamId}`;
}

function getDateFromGameId(gameId: string): string {
  return gameId.slice(0, 8);
}

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

const POS_MAP: Record<string, string> = {
  "투수": "P", "포수": "C", "1루수": "1B", "2루수": "2B",
  "3루수": "3B", "유격수": "SS", "좌익수": "LF", "중견수": "CF",
  "우익수": "RF", "지명타자": "DH",
  "타지": "DH", "타좌": "LF", "타우": "RF", "타중": "CF",
  "타1": "1B", "타2": "2B", "타3": "3B", "타유": "SS", "타포": "C",
  "주좌": "LF", "주우": "RF", "주중": "CF", "주1": "1B", "주2": "2B", "주3": "3B", "주유": "SS",
  "대타": "DH", "대주": "DH",
};

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

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
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

async function fetchPrevGameLineup(
  gameId: string,
  teamId: number,
): Promise<{ batters: LineupPlayer[]; starterName: string } | null> {
  const dateStr = getDateFromGameId(gameId);
  const MAX_LOOKBACK = 5;

  for (let offset = 1; offset <= MAX_LOOKBACK; offset++) {
    const d = shiftDate(dateStr, -offset);
    const games = await fetchGames(d).catch(() => [] as KboGame[]);
    // 더블헤더 대응: 같은 팀의 종료된 경기 중 현재 gameId와 다른 경기만 선택
    // 더블헤더에서는 마지막 경기(2차전)를 선호 (더 최신)
    const teamGames = games.filter(
      g => g.status === "final" && g.gameId !== gameId && (g.awayTeamId === teamId || g.homeTeamId === teamId)
    );
    const teamGame = teamGames.length > 0 ? teamGames[teamGames.length - 1] : null;
    if (!teamGame) continue;

    const isAway = teamGame.awayTeamId === teamId;
    const seasonId = teamGame.gameId.slice(0, 4);
    const body = `leId=1&srId=0&seasonId=${seasonId}&gameId=${teamGame.gameId}`;

    try {
      const res = await fetch(`${KBO_BASE}/GetLineUpAnalysis`, {
        method: "POST",
        headers: HEADERS,
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data) || data.length < 5) continue;

      const batters = parseLineupRows(isAway ? data[4] : data[3]);
      if (batters.length === 0) continue;

      const starterName = isAway ? teamGame.awayStarterName : teamGame.homeStarterName;
      return { batters, starterName };
    } catch {
      continue;
    }
  }
  return null;
}

function computeDiff(
  teamId: number,
  current: { startingPitcher: string; catcher: string; batters: LineupPlayer[] },
  prev: { batters: LineupPlayer[]; starterName: string },
): LineupDiffSide {
  const teamName = getTeamShortName(teamId);
  const diff: LineupDiffSide = {
    teamName,
    starterChanged: null,
    catcherChanged: null,
    newEntries: [],
    removed: [],
    orderChanges: [],
    positionChanges: [],
  };

  // 선발투수는 5일 로테이션이므로 직전 경기와 비교하는 것은 무의미.
  // starterChanged를 diff 대상에서 제외하고, 프롬프트에서 오늘 선발 매치업만 소개.

  const prevNames = new Set(prev.batters.map(b => b.name));
  const currNames = new Set(current.batters.map(b => b.name));
  const prevMap = new Map(prev.batters.map(b => [b.name, b]));
  const currMap = new Map(current.batters.map(b => [b.name, b]));

  const prevCatcher = prev.batters.find(b => b.position === "C");
  if (prevCatcher && current.catcher && prevCatcher.name !== current.catcher) {
    diff.catcherChanged = { from: prevCatcher.name, to: current.catcher };
  }

  for (const name of currNames) {
    if (!prevNames.has(name)) {
      diff.newEntries.push(name);
    }
  }

  for (const name of prevNames) {
    if (!currNames.has(name)) {
      diff.removed.push(name);
    }
  }

  for (const name of currNames) {
    if (!prevNames.has(name)) continue;
    const p = prevMap.get(name)!;
    const c = currMap.get(name)!;
    if (p.order !== c.order) {
      diff.orderChanges.push({ name, from: p.order, to: c.order });
    }
    if (p.position !== c.position) {
      diff.positionChanges.push({ name, from: p.position, to: c.position });
    }
  }

  return diff;
}

function getStarterEra(name: string, teamId: number, clientEra?: string): string | null {
  // 1순위: 클라이언트가 전달한 ERA (KBO API 박스스코어 실시간, 카드 상단과 동일 소스)
  if (clientEra && clientEra !== "-" && clientEra !== "0.00") {
    return `ERA ${clientEra}`;
  }
  // 2순위 (fallback): 2026시즌 누적 JSON. 단, *소수샘플 필터* — 최소 5경기 이상일 때만 올바른 시즌 ERA로 간주.
  // 1~4경기만 던진 선수는 ERA 21.00 같은 극단 값이 나와 사용자 혼란 유발 → 언급 생략.
  const teamName = getTeamShortName(teamId);
  const pitcher = (pitcherStats as Array<{ name: string; team: string; era: string; games: number; wins: number; losses: number }>)
    .find(p => p.name === name && p.team === teamName);
  if (!pitcher) return null;
  if (pitcher.games < 5) return null; // 소수샘플 제외 — 프롬프트에서 아예 언급 안 함
  return `ERA ${pitcher.era}, ${pitcher.wins}승${pitcher.losses}패`;
}

interface RotationResult {
  type: "normal" | "reordered" | "new_starter" | "unknown";
  rotationNames?: string[];
  expectedStarter?: string;
  message?: string;
}

async function fetchRecentStarters(
  teamId: number,
  gameId: string,
  count = 15,
): Promise<{ date: string; starterName: string }[]> {
  const dateStr = getDateFromGameId(gameId);
  const starters: { date: string; starterName: string }[] = [];
  const MAX_LOOKBACK = 30; // look back up to 30 days to find 15 games

  for (let offset = 1; offset <= MAX_LOOKBACK && starters.length < count; offset++) {
    const d = shiftDate(dateStr, -offset);
    const games = await fetchGames(d).catch(() => [] as KboGame[]);
    const teamGames = games.filter(
      g => g.status === "final" && g.gameId !== gameId && (g.awayTeamId === teamId || g.homeTeamId === teamId)
    );
    // 더블헤더 시간순 보장: time("14:00" 등) 기준 정렬
    teamGames.sort((a, b) => a.time.localeCompare(b.time));
    for (const g of teamGames) {
      const starterName = g.awayTeamId === teamId ? g.awayStarterName : g.homeStarterName;
      if (starterName) {
        starters.push({ date: g.date, starterName });
      }
      if (starters.length >= count) break;
    }
  }

  // Return in chronological order (oldest first)
  return starters.reverse();
}

function detectRotationPattern(
  starters: { date: string; starterName: string }[],
  todayStarter: string,
): RotationResult {
  if (starters.length < 8) {
    return { type: "unknown" };
  }

  // Check new_starter first
  const allNames = new Set(starters.map(s => s.starterName));
  if (!allNames.has(todayStarter)) {
    return {
      type: "new_starter",
      rotationNames: [...allNames],
      message: `${todayStarter}은(는) 최근 ${starters.length}경기에 등판 기록이 없는 투수다.`,
    };
  }

  // Try to detect rotation cycle length (4, 5, 6)
  for (const cycleLen of [5, 4, 6]) {
    const result = tryDetectCycle(starters, todayStarter, cycleLen);
    if (result) return result;
  }

  return { type: "unknown" };
}

function tryDetectCycle(
  starters: { date: string; starterName: string }[],
  todayStarter: string,
  cycleLen: number,
): RotationResult | null {
  // Need at least 2 full cycles to establish a pattern
  if (starters.length < cycleLen * 2) return null;

  // Take the most recent starters and look for repeating cycle
  const recent = starters.slice(-cycleLen * 3); // up to 3 cycles worth
  const names = recent.map(s => s.starterName);

  // Extract candidate rotation from the last cycle
  const lastCycle = names.slice(-cycleLen);
  const uniqueInCycle = new Set(lastCycle);

  // A valid cycle should have exactly cycleLen unique pitchers
  if (uniqueInCycle.size !== cycleLen) return null;

  // Check if the cycle before last matches
  if (names.length < cycleLen * 2) return null;
  const prevCycle = names.slice(-(cycleLen * 2), -cycleLen);

  // Count how many positions match between last two cycles
  let matches = 0;
  for (let i = 0; i < cycleLen; i++) {
    if (prevCycle[i] === lastCycle[i]) matches++;
  }

  // Require strong match: at least (cycleLen - 1) positions match
  if (matches < cycleLen - 1) return null;

  const rotationNames = lastCycle;

  // Determine expected next starter
  // The last starter in history is at the end; next would be the one after in rotation
  const lastStarterIdx = rotationNames.indexOf(names[names.length - 1]);
  const expectedIdx = (lastStarterIdx + 1) % cycleLen;
  const expectedStarter = rotationNames[expectedIdx];

  if (todayStarter === expectedStarter) {
    return { type: "normal", rotationNames };
  }

  return {
    type: "reordered",
    rotationNames,
    expectedStarter,
    message: `최근 순환에서 벗어난 기용이다. 로테이션 멤버: ${rotationNames.join(", ")}.`,
  };
}

function buildPrompt(diff: LineupDiff, req: LineupRequest, rotations?: { away: RotationResult; home: RotationResult }): string {
  const awayName = getTeamShortName(req.awayTeamId);
  const homeName = getTeamShortName(req.homeTeamId);

  // 오늘 선발 매치업 정보 (변경이 아닌 소개)
  let batterySection = "오늘 선발 매치업:\n";
  for (const side of [
    { name: awayName, sp: req.lineup.away.startingPitcher, era: req.lineup.away.startingPitcherEra, catcher: req.lineup.away.catcher, teamId: req.awayTeamId, d: diff.away },
    { name: homeName, sp: req.lineup.home.startingPitcher, era: req.lineup.home.startingPitcherEra, catcher: req.lineup.home.catcher, teamId: req.homeTeamId, d: diff.home },
  ]) {
    const eraInfo = getStarterEra(side.sp, side.teamId, side.era);
    batterySection += `${side.name} 선발: ${side.sp}${eraInfo ? ` (${eraInfo})` : ""}\n`;
    if (side.d.catcherChanged) {
      batterySection += `${side.name} 포수 변경: ${side.d.catcherChanged.from} → ${side.d.catcherChanged.to}\n`;
    } else if (side.catcher) {
      // 포수 변경 없으면 직전 경기와 동일 포수. 이름을 명시적으로 감지하여 문장에 들어가도록 함.
      batterySection += `${side.name} 포수: ${side.catcher} (직전 경기와 동일)\n`;
    }
  }

  let lineupSection = "";
  for (const side of [
    { d: diff.away, name: awayName },
    { d: diff.home, name: homeName },
  ]) {
    const parts: string[] = [];
    if (side.d.newEntries.length > 0) {
      parts.push(`새롭게 선발 라인업에 합류: ${side.d.newEntries.join(", ")}`);
    }
    if (side.d.removed.length > 0) {
      parts.push(`직전 경기 대비 제외: ${side.d.removed.join(", ")}`);
    }
    if (side.d.orderChanges.length > 0) {
      parts.push(`타순 변경: ${side.d.orderChanges.map(c => `${c.name} ${c.from}번→${c.to}번`).join(", ")}`);
    }
    if (side.d.positionChanges.length > 0) {
      parts.push(`포지션 변경: ${side.d.positionChanges.map(c => `${c.name} ${c.from}→${c.to}`).join(", ")}`);
    }
    if (parts.length > 0) {
      lineupSection += `[${side.name}]\n${parts.join("\n")}\n`;
    }
  }
  if (!lineupSection) {
    lineupSection = "양 팀 모두 직전 경기와 동일한 라인업\n";
  }

  // 로테이션 분석 섹션 (reordered 또는 new_starter만 포함)
  let rotationSection = "";
  if (rotations) {
    for (const side of [
      { name: awayName, r: rotations.away, sp: req.lineup.away.startingPitcher },
      { name: homeName, r: rotations.home, sp: req.lineup.home.startingPitcher },
    ]) {
      if (side.r.type === "reordered") {
        rotationSection += `[${side.name}] ${side.r.message}\n`;
      } else if (side.r.type === "new_starter") {
        rotationSection += `[${side.name}] ${side.r.message}\n`;
      }
    }
  }

  const rotationPromptSection = rotationSection
    ? `\n## 로테이션 분석\n${rotationSection}`
    : "";

  const hasRotationData = !!rotationSection;

  return `당신은 KBO 프로야구 전문 기자입니다. 오늘 경기의 선발 매치업과 직전 경기 대비 라인업 변경사항을 분석하세요.

## 오늘 선발 매치업
${batterySection}
## 타순 변경 (직전 경기 대비)
${lineupSection}${rotationPromptSection}
## 작성 규칙
1. 존댓말(~습니다/~합니다) 절대 금지. 기사체 반말(~했다/~이다/~있다)로만 작성.
2. 마크다운/HTML 금지, 순수 텍스트만.
3. '콜업', '승격' 등 단정적 표현 금지. 새로 합류한 선수는 '새롭게 선발 라인업에 합류한 선수' 정도로 중립 표현.
4. 변경사항이 없으면 "직전 경기와 동일한 라인업을 유지했다" 정도로 간결하게.
5. 선발투수는 로테이션이므로 "변경"이 아닌 오늘 매치업 소개로 작성. 직전 경기 선발과 비교하지 말 것.
6. 포수 문장 규칙 (피포몰하게):
   - 한 팀만 동일하면 해당 팀 포수 이름 명시: "LG 포수는 직전 경기와 동일한 박동원이 출전한다"
   - 양 팀 다 동일하면 각 팀 포수 이름을 모두 써준다: "LG 박동원, 삼성 강민호가 직전 경기와 동일하게 마스크를 쓴다"
   - 포수 변경이 있으면 diff 대로 언급 (변경 전·후 이름 모두 명시)
   - 정보가 약하거나 포수 이름이 프롬프트에 없으면 **포수 문장 자체를 생략** — 선발 투수 소개만으로 충분하다
   - 처단 금지: "양 팀 포수 라인업은 직전 경기와 동일했다" 같은 이름 없는 추상 표현
7. 제공된 diff 정보만 사용. 없는 정보를 만들지 마세요.
8. 로테이션 관련: "원래 누구 차례였다" 식의 표현 금지. "최근 순환에서 벗어난 기용" 등 중립 표현 사용.
9. **시점 규칙 (매우 중요)**: 이 문장은 **경기 시작 전**에 작성된다. 경기 결과·승패·이닝 내용 등 아직 일어나지 않은 일을 단정하지 말 것. 선발 등판·맞대결·로테이션·포수 기용 사실은 *일어난 일*이므로 "~한다", "~했다" 같은 기사체 반말로 기술 가능. 다만 "시즌 첫 승을 노렸다", "완봉을 노렸다", "호투했다", "무너졌다" 등 **경기 전개·결과를 예단/회고하는 표현 금지**. 예측이 필요하면 "~할 전망이다", "~이(가) 관건이다" 같이 중립적으로.
10. **숫자 규칙 (매우 중요)**: ERA, 승패, 방어율, 타율, 홈런 수 등 **모든 수치는 프롬프트에 명시된 값만 사용**. 프롬프트에 ERA가 없으면 "ERA 몇점대" 같은 추측도 금지. 없는 숫자를 만들어내면 안 된다. 수치 언급이 꼭 필요한 부분은 제공된 "ERA X.XX, N승M패" 문자열을 그대로 인용하거나 생략.

## 출력 형식 (JSON만 출력)
{
  "battery": "선발 매치업 + 포수 변경 분석 50~100자",
  "lineup": "타순 분석 80~150자"${hasRotationData ? ',\n  "rotation": "로테이션 분석 30~80자"' : ""}
}`;
}

function cacheKey(gameId: string) {
  return `lineup_${gameId}`;
}

async function getCached(gameId: string): Promise<{ summary: Record<string, unknown>; outdated: boolean } | null> {
  try {
    const { data } = await supabase
      .from("game_summaries")
      .select("summary, prompt_version")
      .eq("game_id", cacheKey(gameId))
      .single();
    if (!data?.summary) return null;
    const outdated = (data.prompt_version ?? 0) < ANALYSIS_VERSION;
    return { summary: data.summary as Record<string, unknown>, outdated };
  } catch {
    return null;
  }
}

async function saveCache(gameId: string, summary: Record<string, unknown>) {
  try {
    await supabase
      .from("game_summaries")
      .upsert(
        { game_id: cacheKey(gameId), summary, prompt_version: ANALYSIS_VERSION, created_at: new Date().toISOString() },
        { onConflict: "game_id" }
      );
  } catch { /* ignore */ }
}

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "gameId required" }, { status: 400 });

  const cached = await getCached(gameId);
  if (cached && !cached.outdated) {
    return NextResponse.json({ analysis: cached.summary, source: "cache" });
  }
  return NextResponse.json({ analysis: null, source: "none" });
}

export async function POST(req: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
  }

  const body: LineupRequest = await req.json();
  if (!body.gameId || !body.awayTeamId || !body.homeTeamId || !body.lineup) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (!body.lineup.away.batters.length || !body.lineup.home.batters.length) {
    return NextResponse.json({ analysis: null, source: "no_lineup" });
  }

  // KBO LINEUP_CK=false면 fallback 라인업일 가능성 높으므로 AI 생성/캐시 거부.
  // 소비 측(page.tsx / LineupTab)에서도 gate하고 있지만, 서버 측 이중 방어.
  if (body.isLineupConfirmed === false) {
    return NextResponse.json({ analysis: null, source: "not_confirmed" });
  }

  const cached = await getCached(body.gameId);
  if (cached && !cached.outdated) {
    return NextResponse.json({ analysis: cached.summary, source: "cache" });
  }

  const [awayPrev, homePrev, awayStarters, homeStarters] = await Promise.all([
    fetchPrevGameLineup(body.gameId, body.awayTeamId),
    fetchPrevGameLineup(body.gameId, body.homeTeamId),
    fetchRecentStarters(body.awayTeamId, body.gameId),
    fetchRecentStarters(body.homeTeamId, body.gameId),
  ]);

  if (!awayPrev && !homePrev) {
    return NextResponse.json({ analysis: null, source: "no_prev" });
  }

  const rotations = {
    away: detectRotationPattern(awayStarters, body.lineup.away.startingPitcher),
    home: detectRotationPattern(homeStarters, body.lineup.home.startingPitcher),
  };

  const diff: LineupDiff = {
    away: awayPrev
      ? computeDiff(body.awayTeamId, body.lineup.away, awayPrev)
      : { teamName: getTeamShortName(body.awayTeamId), starterChanged: null, catcherChanged: null, newEntries: [], removed: [], orderChanges: [], positionChanges: [] },
    home: homePrev
      ? computeDiff(body.homeTeamId, body.lineup.home, homePrev)
      : { teamName: getTeamShortName(body.homeTeamId), starterChanged: null, catcherChanged: null, newEntries: [], removed: [], orderChanges: [], positionChanges: [] },
    hasDiff: false,
  };

  diff.hasDiff = !!(
    diff.away.catcherChanged ||
    diff.away.newEntries.length || diff.away.removed.length ||
    diff.away.orderChanges.length || diff.away.positionChanges.length ||
    diff.home.catcherChanged ||
    diff.home.newEntries.length || diff.home.removed.length ||
    diff.home.orderChanges.length || diff.home.positionChanges.length
  );

  try {
    const prompt = buildPrompt(diff, body, rotations);

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 512,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!geminiRes.ok) {
      console.error("Gemini lineup-analysis error:", geminiRes.status, await geminiRes.text());
      return NextResponse.json({ error: "Gemini API failed" }, { status: 502 });
    }

    const geminiData = await geminiRes.json();
    const parts = geminiData.candidates?.[0]?.content?.parts ?? [];
    const textParts = parts.filter((p: { text?: string }) => p.text);
    const rawText = textParts.length > 0 ? textParts[textParts.length - 1].text : null;

    if (!rawText) {
      return NextResponse.json({ error: "Empty Gemini response" }, { status: 502 });
    }

    let analysis;
    try {
      analysis = JSON.parse(rawText);
    } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { analysis = JSON.parse(jsonMatch[0]); }
        catch { return NextResponse.json({ error: "Invalid response format" }, { status: 502 }); }
      } else {
        return NextResponse.json({ error: "Invalid response format" }, { status: 502 });
      }
    }

    await saveCache(body.gameId, analysis);
    return NextResponse.json({ analysis, source: "generated" });
  } catch (err) {
    console.error("Lineup analysis generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
