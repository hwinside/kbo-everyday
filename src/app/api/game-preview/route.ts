import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import playersRoster from "@/lib/constants/players-roster.json";
import batterStats from "@/lib/constants/stats-2026-batters.json";
import pitcherStats from "@/lib/constants/stats-2026-pitchers.json";
import { TEAMS } from "@/lib/constants/teams";
import { fetchStandings, fetchGames, fetchBoxScore, type TeamStanding, type BoxScoreResult } from "@/lib/crawler/kbo-api";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const PREVIEW_VERSION = 3;

// Build a set of current roster players (teamShortName:playerName) for filtering
const currentRosterSet = new Set<string>();
for (const p of playersRoster) {
  const team = TEAMS.find(t => t.id === p.teamId);
  if (team) currentRosterSet.add(`${team.shortName}:${p.name}`);
}

interface PreviewRequest {
  gameId: string;
  awayTeamId: number;
  homeTeamId: number;
  awayStarter?: string;
  homeStarter?: string;
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

/** 선발투수 상세 스탯 */
function getStarterStats(name: string, teamId: number): string | null {
  const teamName = getTeamShortName(teamId);
  const pitcher = (pitcherStats as Array<{ name: string; team: string; era: string; wins: number; losses: number; ip: string; so: number; games: number; whip?: string }>)
    .find(p => p.name === name && p.team === teamName);
  if (!pitcher) return null;
  return `${pitcher.name}: ERA ${pitcher.era}, ${pitcher.wins}승${pitcher.losses}패, ${pitcher.ip}이닝, ${pitcher.so}삼진, ${pitcher.games}경기${pitcher.whip ? `, WHIP ${pitcher.whip}` : ""}`;
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

  const awayRank = standings.indexOf(awaySt) + 1;
  const homeRank = standings.indexOf(homeSt) + 1;

  return {
    awayRank,
    awayRecord: `${awaySt.wins}승 ${awaySt.losses}패 ${awaySt.draws}무 (승률 ${awaySt.winRate.toFixed(3)})`,
    awayGb: awaySt.gamesBehind,
    homeRank,
    homeRecord: `${homeSt.wins}승 ${homeSt.losses}패 ${homeSt.draws}무 (승률 ${homeSt.winRate.toFixed(3)})`,
    homeGb: homeSt.gamesBehind,
  };
}

/** 최근 3~4경기 BoxScore에서 Hot/Cold 선수 추출 */
async function getRecentForm(gameId: string, teamId: number): Promise<HotColdPlayer[]> {
  const dateStr = getDateFromGameId(gameId);
  // 최근 4일간 경기 조회
  const dates = [shiftDate(dateStr, -1), shiftDate(dateStr, -2), shiftDate(dateStr, -3), shiftDate(dateStr, -4)];
  const allGames = await Promise.all(dates.map(d => fetchGames(d).catch(() => [])));
  const flat = allGames.flat();

  const teamGames = flat.filter(g =>
    g.status === "final" &&
    (g.awayTeamId === teamId || g.homeTeamId === teamId)
  ).slice(0, 4); // 최대 4경기

  if (teamGames.length === 0) return [];

  // BoxScore 병렬 조회
  const boxScores = await Promise.all(
    teamGames.map(g => fetchBoxScore(g.gameId).catch(() => null))
  );

  // 타자 성적 집계
  const batterMap = new Map<string, { hits: number; atBats: number; hr: number; rbi: number; games: number }>();

  for (let i = 0; i < teamGames.length; i++) {
    const bs = boxScores[i];
    if (!bs) continue;
    const batters = teamGames[i].awayTeamId === teamId ? bs.awayBatters : bs.homeBatters;
    for (const b of batters) {
      if (b.atBats === 0) continue;
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

async function buildPreviewPrompt(req: PreviewRequest): Promise<string> {
  const awayShort = getTeamShortName(req.awayTeamId);
  const homeShort = getTeamShortName(req.homeTeamId);
  const awayName = getTeamName(req.awayTeamId);
  const homeName = getTeamName(req.homeTeamId);

  const awayBatters = getTeamBatters(req.awayTeamId);
  const homeBatters = getTeamBatters(req.homeTeamId);
  const awayPitchers = getTeamPitchers(req.awayTeamId);
  const homePitchers = getTeamPitchers(req.homeTeamId);

  const awayStarterInfo = req.awayStarter ? getStarterStats(req.awayStarter, req.awayTeamId) : null;
  const homeStarterInfo = req.homeStarter ? getStarterStats(req.homeStarter, req.homeTeamId) : null;

  // 런타임 데이터 병렬 조회 (모두 try-catch로 감싸서 실패해도 기존 동작 유지)
  const [seriesCtx, standingsCtx, awayHotPlayers, homeHotPlayers] = await Promise.all([
    getSeriesContext(req.gameId, req.awayTeamId, req.homeTeamId).catch(() => null),
    getStandingsContext(req.awayTeamId, req.homeTeamId).catch(() => null),
    getRecentForm(req.gameId, req.awayTeamId).catch(() => []),
    getRecentForm(req.gameId, req.homeTeamId).catch(() => []),
  ]);

  // 순위 & 시리즈 섹션 빌드
  let standingsSection = "";
  if (standingsCtx) {
    standingsSection = `
## 순위 & 시즌 성적
${awayShort}: ${standingsCtx.awayRank}위 — ${standingsCtx.awayRecord}${standingsCtx.awayGb > 0 ? ` (${standingsCtx.awayGb}게임차)` : " (선두)"}
${homeShort}: ${standingsCtx.homeRank}위 — ${standingsCtx.homeRecord}${standingsCtx.homeGb > 0 ? ` (${standingsCtx.homeGb}게임차)` : " (선두)"}`;
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
${awayStarterInfo || "스탯 미확인"}

## ${homeShort} 선발투수 상세
${homeStarterInfo || "스탯 미확인"}

## ${awayShort} 주요 타자 (2026 시즌 기록)
${awayBatters.join("\n")}

## ${homeShort} 주요 타자 (2026 시즌 기록)
${homeBatters.join("\n")}

## ${awayShort} 투수진 (2026 시즌 기록)
${awayPitchers.join("\n")}

## ${homeShort} 투수진 (2026 시즌 기록)
${homePitchers.join("\n")}
${standingsSection}${seriesSection}${recentFormSection}

## 작성 규칙
1. 반드시 위에 제공된 실제 스탯만 사용. 없는 수치를 만들지 마세요.
2. 두 팀의 장단점을 구체적 수치와 함께 비교 분석하세요.
3. 선발투수의 스타일과 상대 타선의 매치업을 분석하세요.
4. 승률 예측은 선발투수 ERA, 타선 타율, 홈/원정, 순위, 최근 폼 등을 종합 고려하세요.
5. 핵심 포인트는 이 경기만의 고유한 이야기를 담으세요 (선수 간 대결, 기록 도전 등).
6. 부상자 명단에 포함된 선수는 제외하세요. 스탯에 있더라도 최근 경기 출전이 없다면 주의하세요.
7. 한국어로 작성.

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
  return `preview_${gameId}_v${PREVIEW_VERSION}`;
}

async function getCached(gameId: string) {
  try {
    const { data } = await supabase
      .from("game_summaries")
      .select("summary")
      .eq("game_id", cacheKey(gameId))
      .single();
    return data?.summary ?? null;
  } catch {
    return null;
  }
}

async function saveCache(gameId: string, summary: Record<string, unknown>) {
  try {
    await supabase
      .from("game_summaries")
      .upsert(
        { game_id: cacheKey(gameId), summary, created_at: new Date().toISOString() },
        { onConflict: "game_id" }
      );
  } catch { /* ignore */ }
}

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "gameId required" }, { status: 400 });

  const cached = await getCached(gameId);
  if (cached) {
    return NextResponse.json({ preview: cached, source: "cache" });
  }
  return NextResponse.json({ preview: null, source: "none" });
}

export async function POST(req: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
  }

  const body: PreviewRequest = await req.json();
  if (!body.gameId || !body.awayTeamId || !body.homeTeamId) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // 캐시 확인
  const cached = await getCached(body.gameId);
  if (cached) {
    return NextResponse.json({ preview: cached, source: "cache" });
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
