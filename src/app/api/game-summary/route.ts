import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const PROMPT_VERSION = 3; // 프롬프트 변경 시 증가 → 캐시 자동 무효화

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

  return `당신은 20년 경력의 KBO 프로야구 전문 기자입니다. 스포츠 기사처럼 생생하고 서사적인 경기 요약을 작성하세요.
독자는 야구를 사랑하는 팬입니다. 건조한 통계 나열이 아니라, 경기장에 있는 듯한 현장감을 전달하세요.

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
1. 반드시 박스스코어에 있는 숫자만 사용. 없는 사실, 없는 이닝 사건을 만들지 마세요. "선수(숫자)" 형식의 이름이 있으면 그 선수를 언급하지 말고, 해당 팀의 다른 선수나 팀명으로 대체하세요.
2. 이닝별 점수가 있으면 이를 참고해 경기 흐름(초반/중반/후반)을 서술하세요.
3. 이닝별 점수가 없으면 전체 스탯 기반으로 흐름을 추론하되 "X회에~" 같은 구체적 이닝 언급은 피하세요.
4. 스포츠 기자 톤: 문장을 짧고 강하게, 핵심 장면은 생생하게, 선수 이름은 풀네임으로.
5. 각 필드의 분량을 충분히 (각 2~4문장). 전체가 기사 한 편처럼 읽히도록.
6. 무승부일 경우 "무승부"를 명확히.
7. 한국어로 작성.

## 출력 형식 (JSON만 출력)
{
  "headline": "신문 1면 헤드라인 톤. 점수+핵심 이벤트+팀명. 임팩트 있게. (예: '김재환 결승 솔로포! SSG, KIA 꺾고 3연승')",
  "gameFlow": {
    "early": "초반(1~3회) 경기 흐름. 선발 투수 상태, 선취점 상황, 분위기. (2~3문장)",
    "mid": "중반(4~6회) 경기 흐름. 전환점, 추가 득점, 투수 교체 등. (2~3문장)",
    "late": "후반(7~9회+) 경기 흐름. 추격/역전/마무리, 클로징 상황. (2~3문장)"
  },
  "turningPoint": "이 경기의 결정적 승부처. 구체적 상황+숫자+왜 경기를 갈랐는지 해석. 반드시 작성. 무승부여도 가장 팽팽했던 순간을 서술. (3~4문장, 절대 빈 문자열 금지)",
  "mvpBatter": {
    "name": "선수 이름",
    "stats": "구체적 기록 (예: 4타수 3안타 1홈런 3타점)",
    "reason": "왜 이 선수가 오늘의 타자인지. 단순 스탯이 아니라 경기 흐름에서의 의미, 결정적 장면, 팀 승리/분위기에 미친 영향. (2~3문장)"
  },
  "mvpPitcher": {
    "name": "선수 이름 (해당 없으면 전체를 null)",
    "stats": "구체적 기록",
    "reason": "왜 이 투수가 오늘의 투수인지. 경기 흐름 제어, 위기 극복 등 맥락. (2~3문장)"
  },
  "insight": "경기 총평. 양 팀 입장에서 이 경기가 어떤 의미인지, 왜 이런 결과가 나왔는지, 팬이 기억해야 할 포인트. (3~4문장)"
}`;
}

/** 선수(xxx) 패턴을 팀명+역할로 치환 (LLM에 보내기 전 전처리) */
function sanitizePlayerNames(data: BoxScoreInput): BoxScoreInput {
  const PLACEHOLDER_RE = /^선수\(\d+\)$/;

  const sanitizeBatters = (batters: BoxScoreInput["awayBatters"], teamName: string) =>
    batters.map((b, i) => {
      if (PLACEHOLDER_RE.test(b.name)) {
        return { ...b, name: `${teamName} ${i + 1}번째 타자` };
      }
      return b;
    });

  const sanitizePitchers = (pitchers: BoxScoreInput["awayPitchers"], teamName: string) =>
    pitchers.map((p, i) => {
      if (PLACEHOLDER_RE.test(p.name)) {
        const role = i === 0 ? "선발 투수" : `${i + 1}번째 투수`;
        return { ...p, name: `${teamName} ${role}` };
      }
      return p;
    });

  return {
    ...data,
    awayBatters: sanitizeBatters(data.awayBatters, data.awayTeam),
    homeBatters: sanitizeBatters(data.homeBatters, data.homeTeam),
    awayPitchers: sanitizePitchers(data.awayPitchers, data.awayTeam),
    homePitchers: sanitizePitchers(data.homePitchers, data.homeTeam),
  };
}

/** 버전 포함 캐시 키 */
function cacheKey(gameId: string) {
  return `${gameId}_v${PROMPT_VERSION}`;
}

/** Supabase 캐시 조회 (테이블 없으면 null) */
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

/** Supabase에 저장 (테이블 없으면 무시) */
async function saveCache(gameId: string, summary: Record<string, unknown>) {
  try {
    await supabase
      .from("game_summaries")
      .upsert({ game_id: cacheKey(gameId), summary, created_at: new Date().toISOString() }, { onConflict: "game_id" });
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

  // Sanity check: 선수는 있는데 모든 스탯이 0이면 데이터 미완성 → 생성 거부
  const allBatters = [...(body.awayBatters || []), ...(body.homeBatters || [])];
  const allPitchers = [...(body.awayPitchers || []), ...(body.homePitchers || [])];
  const hasBatters = allBatters.length > 0;
  const totalAB = allBatters.reduce((s, b) => s + (b.ab || 0), 0);
  const totalNP = allPitchers.reduce((s, p) => s + (p.np || 0), 0);
  if (hasBatters && totalAB === 0 && totalNP === 0) {
    return NextResponse.json({ error: "BoxScore data appears incomplete (all zeros)" }, { status: 422 });
  }

  // 캐시 확인
  const cached = await getCached(body.gameId);
  if (cached) {
    return NextResponse.json({ summary: cached, source: "cache" });
  }

  // Gemini Flash 호출
  try {
    const sanitized = sanitizePlayerNames(body);
    const prompt = buildPrompt(sanitized);

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errText);
      return NextResponse.json({ error: "Gemini API failed" }, { status: 502 });
    }

    const geminiData = await geminiRes.json();
    // Gemini 2.5 Flash may include thinking parts — use the last text part
    const parts = geminiData.candidates?.[0]?.content?.parts ?? [];
    const textParts = parts.filter((p: { text?: string }) => p.text);
    const rawText = textParts.length > 0 ? textParts[textParts.length - 1].text : null;

    if (!rawText) {
      return NextResponse.json({ error: "Empty Gemini response" }, { status: 502 });
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
          return NextResponse.json({ error: "Invalid Gemini response format" }, { status: 502 });
        }
      } else {
        console.error("Failed to parse Gemini response:", rawText.slice(0, 500));
        return NextResponse.json({ error: "Invalid Gemini response format" }, { status: 502 });
      }
    }

    // 저장 가드: 생성된 요약의 headline이 스코어와 일치하는지 검증
    const headlineStr = (summary.headline || "").toLowerCase();
    const actualScore = `${body.awayScore}` + `${body.homeScore}`;
    const isZeroZero = body.awayScore === 0 && body.homeScore === 0;
    const headlineSaysZero = /0대0|0-0|무승부/.test(headlineStr) || /득점\s*없/.test(headlineStr);
    if (!isZeroZero && headlineSaysZero) {
      // 실제 스코어 ≠ 0-0인데 요약이 0-0 → 오염 데이터, 캐시하지 않고 폐기
      console.error(`Score mismatch: actual ${body.awayScore}-${body.homeScore}, headline says 0-0. Discarding.`);
      return NextResponse.json({ error: "Generated summary score mismatch, discarded" }, { status: 422 });
    }

    // Supabase 캐시 (optional)
    await saveCache(body.gameId, summary);

    return NextResponse.json({ summary, source: "generated" });
  } catch (err) {
    console.error("Game summary generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
