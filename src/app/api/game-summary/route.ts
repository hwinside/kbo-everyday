import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { TEAMS } from "@/lib/constants/teams";
import { fetchStandings, fetchGames } from "@/lib/crawler/kbo-api";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const PROMPT_VERSION = 4; // v4: 기사형 분석 + 맥락 데이터

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ===== Types =====

interface BoxScoreInput {
  gameId: string;
  awayTeam: string;
  homeTeam: string;
  awayScore: number;
  homeScore: number;
  linescore?: {
    away: { innings: (number | null)[]; R?: number; H?: number; E?: number };
    home: { innings: (number | null)[]; R?: number; H?: number; E?: number };
  };
  awayBatters: { name: string; ab: number; r: number; h: number; rbi: number; hr: number; bb: number; so: number; avg: string }[];
  homeBatters: { name: string; ab: number; r: number; h: number; rbi: number; hr: number; bb: number; so: number; avg: string }[];
  awayPitchers: { name: string; ip: string; h: number; r: number; er: number; bb: number; so: number; hr: number; np: number; result?: string }[];
  homePitchers: { name: string; ip: string; h: number; r: number; er: number; bb: number; so: number; hr: number; np: number; result?: string }[];
}

// ===== Team ID helpers =====

const KBO_CODE_TO_ID: Record<string, number> = {
  LG: 1, OB: 2, KT: 3, SK: 4, NC: 5,
  HT: 6, LT: 7, SS: 8, HH: 9, WO: 10,
};

function getTeamShortName(teamId: number): string {
  return TEAMS.find(t => t.id === teamId)?.shortName || `팀${teamId}`;
}

function parseGameMeta(gameId: string): { dateStr: string; awayTeamId: number; homeTeamId: number } | null {
  const m = gameId.match(/^(\d{8})([A-Z]{2})([A-Z]{2})(\d)$/);
  if (!m) return null;
  return {
    dateStr: m[1],
    awayTeamId: KBO_CODE_TO_ID[m[2]] || 0,
    homeTeamId: KBO_CODE_TO_ID[m[3]] || 0,
  };
}

// ===== Context helpers (server-side) =====

function shiftDate(dateStr: string, days: number): string {
  const y = parseInt(dateStr.slice(0, 4));
  const m = parseInt(dateStr.slice(4, 6)) - 1;
  const d = parseInt(dateStr.slice(6, 8));
  const dt = new Date(y, m, d + days);
  return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}`;
}

async function fetchSeriesContext(gameId: string, awayTeamId: number, homeTeamId: number): Promise<string | null> {
  const dateStr = gameId.slice(0, 8);
  const dates = [shiftDate(dateStr, -2), shiftDate(dateStr, -1), shiftDate(dateStr, 1)];
  const allGames = await Promise.all(dates.map(d => fetchGames(d).catch(() => [])));
  const flat = allGames.flat();

  const seriesGames = flat.filter(g =>
    g.gameId !== gameId &&
    ((g.awayTeamId === awayTeamId && g.homeTeamId === homeTeamId) ||
     (g.awayTeamId === homeTeamId && g.homeTeamId === awayTeamId))
  );

  if (seriesGames.length === 0) return null;

  const awayShort = getTeamShortName(awayTeamId);
  const homeShort = getTeamShortName(homeTeamId);
  let awayWins = 0, homeWins = 0;
  const results: string[] = [];

  for (const g of seriesGames) {
    if (g.status !== "final") continue;
    const aScore = g.awayScore ?? 0;
    const hScore = g.homeScore ?? 0;
    if (g.awayTeamId === awayTeamId) {
      if (aScore > hScore) awayWins++;
      else if (hScore > aScore) homeWins++;
    } else {
      if (aScore > hScore) homeWins++;
      else if (hScore > aScore) awayWins++;
    }
    results.push(`${g.date}: ${g.awayName} ${aScore}-${hScore} ${g.homeName}`);
  }

  const totalGames = seriesGames.length + 1;
  let ctx = `${totalGames}연전 중 — ${awayShort} ${awayWins}승, ${homeShort} ${homeWins}승`;
  if (results.length > 0) ctx += `\n이전 결과: ${results.join(", ")}`;
  return ctx;
}

async function fetchStandingsContext(awayTeamId: number, homeTeamId: number): Promise<string | null> {
  const standings = await fetchStandings();
  if (standings.length === 0) return null;

  const awayShort = getTeamShortName(awayTeamId);
  const homeShort = getTeamShortName(homeTeamId);

  const awaySt = standings.find(s => s.teamName === awayShort);
  const homeSt = standings.find(s => s.teamName === homeShort);
  if (!awaySt || !homeSt) return null;

  const awayRank = standings.indexOf(awaySt) + 1;
  const homeRank = standings.indexOf(homeSt) + 1;

  return `${awayShort}: ${awayRank}위 (${awaySt.wins}승 ${awaySt.losses}패, 승률 ${awaySt.winRate.toFixed(3)}${awaySt.gamesBehind > 0 ? `, ${awaySt.gamesBehind}게임차` : ", 선두"})
${homeShort}: ${homeRank}위 (${homeSt.wins}승 ${homeSt.losses}패, 승률 ${homeSt.winRate.toFixed(3)}${homeSt.gamesBehind > 0 ? `, ${homeSt.gamesBehind}게임차` : ", 선두"})`;
}

// ===== Prompt builder =====

function buildPrompt(data: BoxScoreInput, seriesCtx: string | null, standingsCtx: string | null): string {
  const { awayTeam, homeTeam, awayScore, homeScore, linescore, awayBatters, homeBatters, awayPitchers, homePitchers } = data;

  // 이닝별 점수
  let linescoreStr = "";
  if (linescore) {
    const awayInnings = linescore.away.innings.map((v, i) => `${i + 1}회: ${v ?? "-"}`).join(", ");
    const homeInnings = linescore.home.innings.map((v, i) => `${i + 1}회: ${v ?? "-"}`).join(", ");
    linescoreStr = `\n이닝별 점수:\n${awayTeam}: ${awayInnings}\n${homeTeam}: ${homeInnings}`;
  }

  // 에러
  let errorStr = "";
  if (linescore) {
    const awayE = linescore.away.E ?? 0;
    const homeE = linescore.home.E ?? 0;
    if (awayE > 0 || homeE > 0) {
      errorStr = `\n실책: ${awayTeam} ${awayE}개, ${homeTeam} ${homeE}개`;
    }
  }

  // 주요 팩트
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
  const scoreDiff = Math.abs(awayScore - homeScore);

  // 경기 성격 힌트 (LLM이 서사 방향을 잡는 데 도움)
  let gameCharacter = "";
  if (scoreDiff >= 5) gameCharacter = "대승/대패 경기";
  else if (scoreDiff === 1) gameCharacter = "1점차 접전";
  else if (scoreDiff <= 2) gameCharacter = "박빙 승부";
  if (linescore) {
    // 역전 여부 감지
    const awayInns = linescore.away.innings;
    const homeInns = linescore.home.innings;
    let aRunning = 0, hRunning = 0;
    let leadChanged = 0;
    let prevLeader = "";
    for (let i = 0; i < Math.max(awayInns.length, homeInns.length); i++) {
      aRunning += awayInns[i] ?? 0;
      hRunning += homeInns[i] ?? 0;
      const leader = aRunning > hRunning ? "away" : hRunning > aRunning ? "home" : "tie";
      if (leader !== "tie" && leader !== prevLeader && prevLeader !== "" && prevLeader !== "tie") {
        leadChanged++;
      }
      if (leader !== "tie") prevLeader = leader;
    }
    if (leadChanged >= 1) gameCharacter += " / 역전극";
  }
  const totalK = [...awayPitchers, ...homePitchers].reduce((s, p) => s + p.so, 0);
  const totalH = awayBatters.reduce((s, b) => s + b.h, 0) + homeBatters.reduce((s, b) => s + b.h, 0);
  if (totalK >= 15 && totalH <= 10) gameCharacter += " / 투수전";
  if (hrHitters.length >= 3) gameCharacter += " / 홈런 퍼레이드";

  // 맥락 섹션
  let contextSection = "";
  if (seriesCtx) contextSection += `\n## 시리즈 맥락\n${seriesCtx}`;
  if (standingsCtx) contextSection += `\n## 현재 순위\n${standingsCtx}`;

  return `당신은 KBO 프로야구를 20년 넘게 현장에서 취재해온 베테란 스포츠 기자입니다.
마감 시간에 쫓기며 오늘 직접 본 경기의 기사를 쓰고 있습니다.
독자는 야구를 사랑하는 팬입니다. 건조한 통계 나열이 아니라, 경기장에 있는 듯한 현장감을 전달하세요.

## 핵심 원칙 — 반드시 따를 것
1. **매 경기가 다른 이야기다.** 경기 성격에 따라 리드문, 서술 순서, 강조점을 완전히 바꿔라.
   - 대승이면 승리팀 타선 폭발에 집중
   - 접전이면 끝까지 손에 땀 쥐는 긴장감
   - 역전극이면 역전 드라마가 중심
   - 투수전이면 투수 대결의 서사
   - 홈런이 결정적이었으면 홈런 장면이 리드
2. **템플릿 금지.** "X팀이 Y팀을 Z-W로 꺾었다"로 시작하는 판에 박은 리드를 쓰지 마라.
3. **팩트만.** 박스스코어와 이닝별 점수에 있는 것만 사용. 없는 장면, 없는 감정, 없는 관중 반응을 절대 만들지 마라. "선수(숫자)" 형식의 이름은 언급하지 말고 팀명으로 대체.
4. **숫자를 서사로.** "3안타 4타점"을 나열하지 말고, 그 숫자가 경기 흐름에서 왜 중요했는지 해석하라.
5. **빈 칸보다 침묵.** 해당 없는 필드는 null로 두라. 억지로 채우면 품질이 떨어진다.
6. **경기 맥락을 활용하라.** 시리즈 상황(스윕, 위닝시리즈), 순위 영향이 있으면 자연스럽게 녹여서 경기의 의미를 부여하라.

## 경기 데이터
${awayTeam} ${awayScore} : ${homeScore} ${homeTeam} (${result})
경기 성격: ${gameCharacter || "일반"}
${linescoreStr}${errorStr}

## 주요 팩트
- 홈런: ${hrHitters.length > 0 ? hrHitters.join(", ") : "없음"}
- 멀티히트: ${multiHitters.length > 0 ? multiHitters.join(", ") : "없음"}
- ${awayTeam} 선발: ${awayStarter?.name} ${awayStarter?.ip}이닝 ${awayStarter?.er}자책 ${awayStarter?.so}삼진 ${awayStarter?.np}투구${awayStarter?.result ? ` (${awayStarter.result})` : ""}
- ${homeTeam} 선발: ${homeStarter?.name} ${homeStarter?.ip}이닝 ${homeStarter?.er}자책 ${homeStarter?.so}삼진 ${homeStarter?.np}투구${homeStarter?.result ? ` (${homeStarter.result})` : ""}

## ${awayTeam} 타자 상세
${awayBatters.map(b => `${b.name}: ${b.ab}타수 ${b.h}안타 ${b.r}득점 ${b.rbi}타점 ${b.hr}홈런 ${b.bb}볼넷 ${b.so}삼진`).join("\n")}

## ${homeTeam} 타자 상세
${homeBatters.map(b => `${b.name}: ${b.ab}타수 ${b.h}안타 ${b.r}득점 ${b.rbi}타점 ${b.hr}홈런 ${b.bb}볼넷 ${b.so}삼진`).join("\n")}

## ${awayTeam} 투수 상세
${awayPitchers.map(p => `${p.name}: ${p.ip}이닝 피안타${p.h} ${p.er}자책 ${p.bb}볼넷 ${p.so}삼진 ${p.np}투구${p.result ? ` (${p.result})` : ""}`).join("\n")}

## ${homeTeam} 투수 상세
${homePitchers.map(p => `${p.name}: ${p.ip}이닝 피안타${p.h} ${p.er}자책 ${p.bb}볼넷 ${p.so}삼진 ${p.np}투구${p.result ? ` (${p.result})` : ""}`).join("\n")}
${contextSection}

## 출력 형식 (JSON 객체 하나만 출력. 마크다운/설명 텍스트 절대 금지.)
{
  "headline": "신문 1면 헤드라인. 핵심 이벤트+점수+팀명. 임팩트 있게. 매번 다른 구조로. (예: '오스틴 끝내기 2점포! LG, 9회 대역전극', '원태인 7이닝 1실점 역투, 삼성 투수전 제압')",
  "gameFlow": {
    "early": "초반(1~3회) 경기 흐름. 선발 투수 상태, 선취점 상황. 이닝별 점수 참고. 2~3문장.",
    "mid": "중반(4~6회) 경기 흐름. 전환점, 추가 득점, 투수 교체 등. 2~3문장.",
    "late": "후반(7~9회+) 경기 흐름. 추격/역전/마무리. 2~3문장."
  },
  "turningPoint": "이 경기의 결정적 승부처. 구체적 상황+숫자+왜 경기를 갈랐는지 해석. 무승부여도 가장 팽팽했던 순간. 3~4문장. 반드시 작성. 빈 문자열 절대 금지.",
  "mvpBatter": {
    "name": "선수 이름",
    "stats": "구체적 기록 (예: 4타수 3안타 1홈런 3타점)",
    "reason": "경기 흐름에서의 의미. 결정적 장면. 2~3문장."
  },
  "mvpPitcher": null 또는 { "name": "...", "stats": "...", "reason": "..." },
  "insight": "경기 총평. 양 팀 입장에서 이 경기의 의미. 팬이 기억해야 할 포인트. 시리즈/순위 맥락이 있으면 자연스럽게 포함. 3~4문장.",
  "seriesContext": "시리즈 맥락 요약 — 스윕/위닝시리즈/시리즈 분위기 (데이터 없으면 null)",
  "standingsImpact": "이 결과로 순위가 어떻게 영향받는지 한 줄 분석 (데이터 없으면 null)"
}`;
}

// ===== Sanitizer =====

function sanitizePlayerNames(data: BoxScoreInput): BoxScoreInput {
  const PLACEHOLDER_RE = /^선수\(\d+\)$/;
  const sanitizeBatters = (batters: BoxScoreInput["awayBatters"], teamName: string) =>
    batters.map((b, i) => PLACEHOLDER_RE.test(b.name) ? { ...b, name: `${teamName} ${i + 1}번째 타자` } : b);
  const sanitizePitchers = (pitchers: BoxScoreInput["awayPitchers"], teamName: string) =>
    pitchers.map((p, i) => PLACEHOLDER_RE.test(p.name) ? { ...p, name: `${teamName} ${i === 0 ? "선발 투수" : `${i + 1}번째 투수`}` } : p);
  return {
    ...data,
    awayBatters: sanitizeBatters(data.awayBatters, data.awayTeam),
    homeBatters: sanitizeBatters(data.homeBatters, data.homeTeam),
    awayPitchers: sanitizePitchers(data.awayPitchers, data.awayTeam),
    homePitchers: sanitizePitchers(data.homePitchers, data.homeTeam),
  };
}

// ===== Cache =====

function cacheKey(gameId: string) {
  return `${gameId}_v${PROMPT_VERSION}`;
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
      .upsert({ game_id: cacheKey(gameId), summary, created_at: new Date().toISOString() }, { onConflict: "game_id" });
  } catch { /* ignore */ }
}

// ===== Normalize =====

function normalizeSummary(s: Record<string, unknown>): Record<string, unknown> {
  const gf = s.gameFlow as Record<string, unknown> | undefined;
  if (gf) {
    if (!s.insight && gf.insight) { s.insight = gf.insight; delete gf.insight; }
    if (!s.turningPoint && gf.turningPoint) { s.turningPoint = gf.turningPoint; delete gf.turningPoint; }
    if (!s.mvpBatter && gf.mvpBatter) { s.mvpBatter = gf.mvpBatter; delete gf.mvpBatter; }
    if (!s.mvpPitcher && gf.mvpPitcher) { s.mvpPitcher = gf.mvpPitcher; delete gf.mvpPitcher; }
  }
  return s;
}

// ===== Route handlers =====

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "gameId required" }, { status: 400 });

  const cached = await getCached(gameId);
  if (cached) {
    return NextResponse.json({ summary: normalizeSummary(cached as Record<string, unknown>), source: "cache" });
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

  // Sanity check
  const allBatters = [...(body.awayBatters || []), ...(body.homeBatters || [])];
  const allPitchers = [...(body.awayPitchers || []), ...(body.homePitchers || [])];
  const totalAB = allBatters.reduce((s, b) => s + (b.ab || 0), 0);
  const totalNP = allPitchers.reduce((s, p) => s + (p.np || 0), 0);
  if (allBatters.length > 0 && totalAB === 0 && totalNP === 0) {
    return NextResponse.json({ error: "BoxScore data appears incomplete (all zeros)" }, { status: 422 });
  }

  // 캐시 확인
  const cached = await getCached(body.gameId);
  if (cached) {
    return NextResponse.json({ summary: normalizeSummary(cached as Record<string, unknown>), source: "cache" });
  }

  // 맥락 데이터 병렬 조회 (실패해도 진행)
  const meta = parseGameMeta(body.gameId);
  const [seriesCtx, standingsCtx] = await Promise.all([
    meta ? fetchSeriesContext(body.gameId, meta.awayTeamId, meta.homeTeamId).catch(() => null) : Promise.resolve(null),
    meta ? fetchStandingsContext(meta.awayTeamId, meta.homeTeamId).catch(() => null) : Promise.resolve(null),
  ]);

  // Gemini 호출
  try {
    const sanitized = sanitizePlayerNames(body);
    const prompt = buildPrompt(sanitized, seriesCtx, standingsCtx);

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.85,
          maxOutputTokens: 2560,
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
        try { summary = JSON.parse(jsonMatch[0]); }
        catch {
          console.error("JSON parse failed:", jsonMatch[0].slice(0, 500));
          return NextResponse.json({ error: "Invalid Gemini response format" }, { status: 502 });
        }
      } else {
        console.error("No JSON found:", rawText.slice(0, 500));
        return NextResponse.json({ error: "Invalid Gemini response format" }, { status: 502 });
      }
    }

    // 정규화
    normalizeSummary(summary);

    // 스코어 검증
    const headlineStr = (summary.headline || "").toLowerCase();
    const isZeroZero = body.awayScore === 0 && body.homeScore === 0;
    const headlineSaysZero = /0대0|0-0|무승부/.test(headlineStr) || /득점\s*없/.test(headlineStr);
    if (!isZeroZero && headlineSaysZero) {
      console.error(`Score mismatch: actual ${body.awayScore}-${body.homeScore}, headline says 0-0. Discarding.`);
      return NextResponse.json({ error: "Generated summary score mismatch, discarded" }, { status: 422 });
    }

    await saveCache(body.gameId, summary);
    return NextResponse.json({ summary, source: "generated" });
  } catch (err) {
    console.error("Game summary generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
