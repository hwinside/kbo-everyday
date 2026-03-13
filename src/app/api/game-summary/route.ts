import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface BoxScoreInput {
  gameId: string;
  awayTeam: string;
  homeTeam: string;
  awayScore: number;
  homeScore: number;
  linescore?: { away: { innings: (number | null)[] }; home: { innings: (number | null)[] } };
  awayBatters: { name: string; ab: number; r: number; h: number; rbi: number; hr: number; bb: number; so: number; avg: string }[];
  homeBatters: { name: string; ab: number; r: number; h: number; rbi: number; hr: number; bb: number; so: number; avg: string }[];
  awayPitchers: { name: string; ip: string; h: number; r: number; er: number; bb: number; so: number; hr: number; np: number; result?: string }[];
  homePitchers: { name: string; ip: string; h: number; r: number; er: number; bb: number; so: number; hr: number; np: number; result?: string }[];
}

function buildPrompt(data: BoxScoreInput): string {
  const { awayTeam, homeTeam, awayScore, homeScore, linescore, awayBatters, homeBatters, awayPitchers, homePitchers } = data;

  let linescoreStr = "";
  if (linescore) {
    const awayInnings = linescore.away.innings.map((v, i) => `${i + 1}회: ${v ?? "-"}`).join(", ");
    const homeInnings = linescore.home.innings.map((v, i) => `${i + 1}회: ${v ?? "-"}`).join(", ");
    linescoreStr = `\n이닝별 점수:\n${awayTeam}: ${awayInnings}\n${homeTeam}: ${homeInnings}`;
  }

  const hrHitters = [
    ...awayBatters.filter(b => b.hr > 0).map(b => `${awayTeam} ${b.name} (${b.hr}홈런 ${b.rbi}타점)`),
    ...homeBatters.filter(b => b.hr > 0).map(b => `${homeTeam} ${b.name} (${b.hr}홈런 ${b.rbi}타점)`),
  ];

  const multiHitters = [
    ...awayBatters.filter(b => b.h >= 2).map(b => `${awayTeam} ${b.name} (${b.ab}타수 ${b.h}안타 ${b.rbi}타점)`),
    ...homeBatters.filter(b => b.h >= 2).map(b => `${homeTeam} ${b.name} (${b.ab}타수 ${b.h}안타 ${b.rbi}타점)`),
  ];

  const awayStarter = awayPitchers[0];
  const homeStarter = homePitchers[0];

  const result = awayScore === homeScore ? "무승부" : awayScore > homeScore ? `${awayTeam} 승리` : `${homeTeam} 승리`;

  return `당신은 KBO 프로야구 전문 기자입니다. 아래 박스스코어 데이터를 바탕으로 경기 요약을 작성하세요.

## 경기 결과
${awayTeam} ${awayScore} : ${homeScore} ${homeTeam} (${result})
${linescoreStr}

## 주요 팩트
- 홈런: ${hrHitters.length > 0 ? hrHitters.join(", ") : "없음"}
- 멀티히트: ${multiHitters.length > 0 ? multiHitters.join(", ") : "없음"}
- ${awayTeam} 선발: ${awayStarter?.name} ${awayStarter?.ip}이닝 ${awayStarter?.er}자책 ${awayStarter?.so}삼진 ${awayStarter?.np}투구
- ${homeTeam} 선발: ${homeStarter?.name} ${homeStarter?.ip}이닝 ${homeStarter?.er}자책 ${homeStarter?.so}삼진 ${homeStarter?.np}투구

## ${awayTeam} 타자 상세
${awayBatters.map(b => `${b.name}: ${b.ab}타수 ${b.h}안타 ${b.r}득점 ${b.rbi}타점 ${b.hr}홈런 ${b.bb}볼넷 ${b.so}삼진`).join("\n")}

## ${homeTeam} 타자 상세
${homeBatters.map(b => `${b.name}: ${b.ab}타수 ${b.h}안타 ${b.r}득점 ${b.rbi}타점 ${b.hr}홈런 ${b.bb}볼넷 ${b.so}삼진`).join("\n")}

## ${awayTeam} 투수 상세
${awayPitchers.map(p => `${p.name}: ${p.ip}이닝 피안타${p.h} ${p.er}자책 ${p.bb}볼넷 ${p.so}삼진 ${p.np}투구${p.result ? ` (${p.result})` : ""}`).join("\n")}

## ${homeTeam} 투수 상세
${homePitchers.map(p => `${p.name}: ${p.ip}이닝 피안타${p.h} ${p.er}자책 ${p.bb}볼넷 ${p.so}삼진 ${p.np}투구${p.result ? ` (${p.result})` : ""}`).join("\n")}

## 작성 규칙
1. 반드시 박스스코어에 있는 숫자만 사용하세요. 없는 사실을 절대 만들지 마세요.
2. 야구팬이 읽고 "아 그 경기!" 하고 떠올릴 수 있도록 서사적으로 쓰세요.
3. 무승부일 경우 "무승부"를 명확히 하세요.
4. 각 필드는 반드시 구체적 숫자 근거를 포함하세요.
5. 헤드라인은 기자처럼 임팩트 있게 쓰세요 (예: "김재환 결승 솔로포! SSG, KIA 잡고 시범경기 3연승").
6. 한국어로 작성하세요.

## 출력 형식 (JSON만 출력, 다른 텍스트 없이)
{
  "headline": "한 줄 헤드라인 (기자 톤, 점수+핵심 이벤트 포함)",
  "turningPoint": "승부처 (구체적 이닝+상황+숫자, 2-3문장)",
  "mvpBatter": "오늘의 타자 — 이름 + 성적 + 왜 돋보였는지 (1-2문장)",
  "mvpPitcher": "오늘의 투수 — 이름 + 성적 + 포인트 (1-2문장, 해당 없으면 null)",
  "insight": "경기 총평 — 왜 이런 결과가 나왔는지, 양 팀 관점 해석 (2-3문장)"
}`;
}

/** Supabase 캐시 조회 (테이블 없으면 null) */
async function getCached(gameId: string) {
  try {
    const { data } = await supabase
      .from("game_summaries")
      .select("summary")
      .eq("game_id", gameId)
      .single();
    return data?.summary ?? null;
  } catch {
    return null; // 테이블 없어도 에러 안 남
  }
}

/** Supabase에 저장 (테이블 없으면 무시) */
async function saveCache(gameId: string, summary: Record<string, unknown>) {
  try {
    await supabase
      .from("game_summaries")
      .upsert({ game_id: gameId, summary, created_at: new Date().toISOString() }, { onConflict: "game_id" });
  } catch {
    // 테이블 없으면 그냥 무시
  }
}

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "gameId required" }, { status: 400 });

  const cached = await getCached(gameId);
  if (cached) {
    return NextResponse.json({ summary: cached, source: "cache" });
  }

  return NextResponse.json({ summary: null, source: "none" });
}

export async function POST(req: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
  }

  const body: BoxScoreInput = await req.json();
  if (!body.gameId || !body.awayTeam || !body.homeTeam) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // 캐시 확인
  const cached = await getCached(body.gameId);
  if (cached) {
    return NextResponse.json({ summary: cached, source: "cache" });
  }

  // Gemini Flash 호출
  try {
    const prompt = buildPrompt(body);

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errText);
      return NextResponse.json({ error: "Gemini API failed", status: geminiRes.status, detail: errText.slice(0, 500) }, { status: 502 });
    }

    const geminiData = await geminiRes.json();
    // Gemini 2.5 Flash may include thinking parts — use the last text part
    const parts = geminiData.candidates?.[0]?.content?.parts ?? [];
    const textParts = parts.filter((p: { text?: string }) => p.text);
    const rawText = textParts.length > 0 ? textParts[textParts.length - 1].text : null;

    if (!rawText) {
      return NextResponse.json({ error: "Empty Gemini response", parts: JSON.stringify(parts).slice(0, 500) }, { status: 502 });
    }

    let summary;
    try {
      summary = JSON.parse(rawText);
    } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          summary = JSON.parse(jsonMatch[0]);
        } catch {
          console.error("JSON match parse failed:", jsonMatch[0].slice(0, 500));
          return NextResponse.json({ error: "Invalid Gemini response format", raw: rawText.slice(0, 800) }, { status: 502 });
        }
      } else {
        console.error("Failed to parse Gemini response:", rawText.slice(0, 500));
        return NextResponse.json({ error: "Invalid Gemini response format", raw: rawText.slice(0, 800) }, { status: 502 });
      }
    }

    // Supabase 캐시 (optional)
    await saveCache(body.gameId, summary);

    return NextResponse.json({ summary, source: "generated" });
  } catch (err) {
    console.error("Game summary generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
