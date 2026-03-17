import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import playersRoster from "@/lib/constants/players-roster.json";
import batterStats from "@/lib/constants/stats-2025-batters.json";
import pitcherStats from "@/lib/constants/stats-2025-pitchers.json";
import { TEAMS } from "@/lib/constants/teams";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const PREVIEW_VERSION = 1;

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

/** 팀 주요 타자 스탯 (타율 상위 5명) */
function getTeamBatters(teamId: number) {
  const teamName = getTeamShortName(teamId);
  return (batterStats as Array<{ name: string; team: string; avg: string; hr: number; rbi: number; hits: number; games: number; ob?: string; obp?: string; ops?: string }>)
    .filter(b => b.team === teamName)
    .sort((a, b) => parseFloat(b.avg) - parseFloat(a.avg))
    .slice(0, 8)
    .map(b => `${b.name} (타율 ${b.avg}, ${b.hr}홈런, ${b.rbi}타점, ${b.games}경기)`);
}

/** 팀 주요 투수 스탯 */
function getTeamPitchers(teamId: number) {
  const teamName = getTeamShortName(teamId);
  return (pitcherStats as Array<{ name: string; team: string; era: string; wins: number; losses: number; saves: number; holds: number; ip: string; so: number; games: number; whip?: string }>)
    .filter(p => p.team === teamName)
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

function buildPreviewPrompt(req: PreviewRequest): string {
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

## ${awayShort} 주요 타자 (2025 시즌 기록)
${awayBatters.join("\n")}

## ${homeShort} 주요 타자 (2025 시즌 기록)
${homeBatters.join("\n")}

## ${awayShort} 투수진 (2025 시즌 기록)
${awayPitchers.join("\n")}

## ${homeShort} 투수진 (2025 시즌 기록)
${homePitchers.join("\n")}

## 작성 규칙
1. 반드시 위에 제공된 실제 스탯만 사용. 없는 수치를 만들지 마세요.
2. 두 팀의 장단점을 구체적 수치와 함께 비교 분석하세요.
3. 선발투수의 스타일과 상대 타선의 매치업을 분석하세요.
4. 승률 예측은 선발투수 ERA, 타선 타율, 홈/원정 등을 종합 고려하세요.
5. 핵심 포인트는 이 경기만의 고유한 이야기를 담으세요 (선수 간 대결, 기록 도전 등).
6. 한국어로 작성.

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
  "homeKeyPlayers": [{"name": "선수명", "reason": "왜 키플레이어인지 1~2문장"}]
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
    const prompt = buildPreviewPrompt(body);

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 1536,
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
