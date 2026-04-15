import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { fetchStandings, fetchGames, fetchBoxScore, type BoxScoreResult } from "@/lib/crawler/kbo-api";
import { TEAMS } from "@/lib/constants/teams";
import {
  computeStandingsDelta,
  computeTitlesDelta,
  computeStreak,
  extractGameEvents,
  extractHighlights,
  type StandingsSnapshot,
  type StatsSnapshotRow,
  type StandingsDelta,
  type TitlesDelta,
  type GameEvent,
  type GameHighlight,
} from "@/lib/analysis/daily-delta";

const CRON_SECRET = process.env.CRON_SECRET || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const PROMPT_VERSION = 1;

const KBO_BASE = "https://www.koreabaseball.com";

// ===== Date helpers =====

function getKSTDate(offset = 0): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000 + offset * 24 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
}

function toKboDate(isoDate: string): string {
  return isoDate.replace(/-/g, ""); // YYYYMMDD
}

// ===== HTML fetch helpers (from cron/stats pattern) =====

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: KBO_BASE,
    },
    next: { revalidate: 0 },
  });
  return res.text();
}

function parseTable(html: string): string[][] {
  const rows: string[][] = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return rows;
  const trMatches = tbodyMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!trMatches) return rows;
  for (const tr of trMatches) {
    const cells: string[] = [];
    const tdMatches = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (tdMatches) {
      for (const td of tdMatches) {
        cells.push(td.replace(/<[^>]+>/g, "").trim());
      }
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

// ===== Stats fetchers for title snapshots =====

interface TitleEntry {
  category: string;
  rank: number;
  player_name: string;
  team: string;
  value: number;
}

const BATTER_TITLES: { category: string; sort: string; colIndex: number }[] = [
  { category: "avg", sort: "HRA_RT", colIndex: 3 },
  { category: "hr", sort: "HR_CN", colIndex: 11 },
  { category: "rbi", sort: "RBI_CN", colIndex: 13 },
  { category: "sb", sort: "SB_CN", colIndex: -1 }, // Runner page
];

const PITCHER_TITLES: { category: string; sort: string; colIndex: number }[] = [
  { category: "era", sort: "ERA_RT", colIndex: 3 },
  { category: "wins", sort: "W_CN", colIndex: 5 },
  { category: "k", sort: "KK_CN", colIndex: 15 },
  { category: "saves", sort: "SV_CN", colIndex: 7 },
  { category: "whip", sort: "WHIP_RT", colIndex: 18 },
];

async function fetchBatterTitleEntries(): Promise<TitleEntry[]> {
  const entries: TitleEntry[] = [];

  for (const title of BATTER_TITLES) {
    if (title.category === "sb") {
      const html = await fetchHtml(`${KBO_BASE}/Record/Player/Runner/Basic.aspx?sort=SB_CN`);
      const rows = parseTable(html);
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const c = rows[i];
        entries.push({
          category: "sb",
          rank: i + 1,
          player_name: c[1] || "",
          team: c[2] || "",
          value: parseInt(c[3]) || 0, // SB column in Runner page
        });
      }
      continue;
    }

    const html = await fetchHtml(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=${title.sort}`);
    const rows = parseTable(html);
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const c = rows[i];
      const raw = c[title.colIndex] || "0";
      entries.push({
        category: title.category,
        rank: i + 1,
        player_name: c[1] || "",
        team: c[2] || "",
        value: parseFloat(raw) || 0,
      });
    }
  }

  return entries;
}

async function fetchPitcherTitleEntries(): Promise<TitleEntry[]> {
  const entries: TitleEntry[] = [];

  for (const title of PITCHER_TITLES) {
    const html = await fetchHtml(`${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=${title.sort}`);
    const rows = parseTable(html);
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const c = rows[i];
      const raw = c[title.colIndex] || "0";
      entries.push({
        category: title.category,
        rank: i + 1,
        player_name: c[1] || "",
        team: c[2] || "",
        value: parseFloat(raw) || 0,
      });
    }
  }

  return entries;
}

// ===== Gemini prompts =====

function buildStandingsPrompt(delta: StandingsDelta, events: GameEvent[], teamNames: Map<number, string>, highlights: GameHighlight[] = [], newsHeadlines: string[] = [], boxScores: Map<string, BoxScoreResult> = new Map()): string {
  const eventLines = events.map((e) => {
    const box = boxScores.get(e.gameId);
    let starterInfo = "";
    if (box) {
      const awaySP = box.awayPitchers[0];
      const homeSP = box.homePitchers[0];
      const parts: string[] = [];
      if (awaySP) parts.push(`${e.awayTeam}선발 ${awaySP.name} ${awaySP.inningsPitched}이닝 ${awaySP.earnedRuns}자책`);
      if (homeSP) parts.push(`${e.homeTeam}선발 ${homeSP.name} ${homeSP.inningsPitched}이닝 ${homeSP.earnedRuns}자책`);
      if (parts.length > 0) starterInfo = ` [${parts.join(", ")}]`;
    }
    return `${e.awayTeam} ${e.awayScore}:${e.homeScore} ${e.homeTeam} (승: ${e.winPitcher || "-"}, 패: ${e.losePitcher || "-"})${starterInfo}`;
  }).join("\n");

  const teamDeltas = [...delta.top, ...delta.mid, ...delta.bottom].map((d) => {
    const name = teamNames.get(d.team_id) || `팀${d.team_id}`;
    const change = d.rankChange > 0 ? `↑${d.rankChange}` : d.rankChange < 0 ? `↓${Math.abs(d.rankChange)}` : "-";
    const streakNum = parseInt(d.streak || "0");
    const streakText = Math.abs(streakNum) >= 3 ? `${Math.abs(streakNum)}${streakNum > 0 ? "연승" : "연패"} 중` : "";
    const rankInfo = d.rankChange !== 0 ? `${d.oldRank}위→${d.newRank}위(${change})` : `${d.newRank}위(변동없음)`;
    return `${rankInfo} ${name}: ${d.wins}승${d.losses}패${d.draws}무 (${d.games_behind}게임차)${streakText ? `, ${streakText}` : ""}`;
  }).join("\n");

  return `당신은 KBO 프로야구 전문 데이터 분석 기자입니다.
아래 데이터를 바탕으로 오늘의 순위 동향을 기사체 반말(~다)로 작성하세요.

## 핵심 원칙
0. 존댓말(~습니다/~합니다) 절대 금지. 기사체 반말(~했다/~됐다/~있다)로만 작성하세요.
1. 제공된 데이터 외의 정보를 사용하지 마세요.
2. 날짜를 절대 직접 언급하지 마세요. "오늘", "4월 17일" 등 구체적 날짜 표현 금지.
3. 마크다운/HTML 문법 금지. ##, **, *, - 등 서식 없이 순수 텍스트로만 작성.
4. 승률은 언급하지 마세요.
5. 3연승/3연패 미만의 streak는 언급하지 마세요.
6. 상위권/중위권/하위권으로 나누지 말고, 순위 변동 팀 중심으로 서술. 변동 없는 팀은 생략.
7. "순위표 해설"이 아니라 "어제 KBO에서 무슨 일이 있었는지" 요약하는 느낌으로.
8. 총론/도입부 없이 바로 핵심 사건부터 시작하세요.
9. 언급 팀은 최대 3~4팀으로 제한. 나머지는 과감히 생략.
10. 순위 변동 정확성 필수: 데이터에 X위→Y위로 명시되어 있으니 반드시 그대로 사용. 올랐다/떨어졌다는 실제 순위 변동이 있을 때만. 변동없음이면 X위를 유지했다로 쓰세요.
11. 선수 이름 필수: 본문에 선수명을 최소 1~2명 포함하세요. 팀 단위만 쓰면 AI 느낌이 납니다.
12. 승리투수 = 경기 주인공이 아닙니다. 승리투수라는 이유만으로 호투로 이겼다 금지. 선발이 5이닝+ 투구했으면 선발 서사 우선. 결승타/만루포 친 타자가 있으면 타자 서사 우선.
13. 뉴스 헤드라인 반드시 반영: 헤드라인 중 최소 1개는 구체적 사건으로 본문에 녹여야 합니다. 선수명 언급된 뉴스 우선.
13. 스코어/순위 팩트는 반드시 위 경기 데이터 기준. 뉴스는 맥락 보강용.
14. 이벤트가 없으면 순위 변동만으로 서술.

## 어제 경기 결과
${eventLines || "경기 없음"}

## 현재 순위 (변동 포함)
${teamDeltas}

${highlights.length > 0 ? `## 어제의 주요 이벤트\n${highlights.map((h) => `- ${h.team} ${h.text}`).join("\n")}\n\n` : ""}${newsHeadlines.length > 0 ? `## 어제 뉴스 헤드라인 (맥락 보강용, 팩트는 위 데이터 기준)\n${newsHeadlines.map((h) => `- ${h}`).join("\n")}\n\n` : ""}## 출력 형식 (JSON 객체 하나만 출력)
{ "content": "어제 KBO 전체 조망 요약 (순위 변동팀 중심, 150~250자, 마크다운/날짜 금지)" }`;
}

function buildTitlePrompt(
  delta: TitlesDelta,
  events: GameEvent[],
  type: "batter" | "pitcher",
): string {
  const label = type === "batter" ? "타자 타이틀" : "투수 타이틀";
  const cats = type === "batter"
    ? ["avg", "hr", "rbi", "sb"]
    : ["era", "wins", "k", "saves", "whip"];
  const catNames: Record<string, string> = {
    avg: "타율", hr: "홈런", rbi: "타점", sb: "도루",
    era: "평균자책점", wins: "승수", k: "탈삼진", saves: "세이브", whip: "WHIP",
  };

  const eventLines = events.map(
    (e) => `${e.awayTeam} ${e.awayScore}:${e.homeScore} ${e.homeTeam}`,
  ).join("\n");

  const catData = delta.categories
    .filter((c) => cats.includes(c.category))
    .map((c) => {
      const name = catNames[c.category] || c.category;
      const leader = c.leaderChanged
        ? `1위 교체: ${c.oldLeader?.player_name}(${c.oldLeader?.team}) → ${c.newLeader.player_name}(${c.newLeader.team})`
        : `1위 유지: ${c.newLeader.player_name}(${c.newLeader.team}, ${c.newLeader.value})`;
      const top5 = c.top5.map((p) => {
        const rc = p.rankChange > 0 ? `↑${p.rankChange}` : p.rankChange < 0 ? `↓${Math.abs(p.rankChange)}` : "-";
        return `  ${p.player_name}(${p.team}) ${p.value} [순위변동: ${rc}]`;
      }).join("\n");
      return `### ${name}\n${leader}\n${top5}`;
    }).join("\n\n");

  return `당신은 KBO 프로야구 전문 데이터 분석 기자입니다.
아래 데이터를 바탕으로 오늘의 ${label} 변동을 기사체 반말(~다)로 작성하세요.

## 핵심 원칙
0. 존댓말(~습니다/~합니다) 절대 금지. 기사체 반말(~했다/~됐다/~있다)로만 작성하세요.
1. 제공된 데이터 외의 정보를 사용하지 마세요.
2. 날짜를 절대 직접 언급하지 마세요. "오늘", "4월 17일" 등 구체적 날짜 표현 금지.
3. 마크다운/HTML 문법 금지. ##, **, *, - 등 서식 없이 순수 텍스트로만 작성하세요.
4. 각 카테고리별 변동을 서술하되, 1위 교체가 있으면 중점적으로 다루세요.
5. 어제 경기 결과와 연결해서 왜 수치가 변했는지 설명하세요.
6. 구체적 수치를 자연스럽게 녹여 서술하세요.

## 어제 경기 결과
${eventLines || "경기 없음"}

## ${label} 변동
${catData}

## 출력 형식 (JSON 객체 하나만 출력)
{ "content": "${label} 변동 기사 본문 (150~250자, 마크다운 금지, 날짜 언급 금지)" }`;
}

// ===== Gemini call =====

async function fetchNewsHeadlines(dateStr: string): Promise<string[]> {
  if (!GEMINI_API_KEY) return [];
  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${dateStr} KBO 프로야구 주요 뉴스 헤드라인 5개를 알려줘. 제목만 간결하게, 한 줄씩.` }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text || "";
    // Parse bullet points or numbered list
    const lines = text.split("\n").map((l: string) => l.replace(/^[\s*\-\d.]+/, "").trim()).filter((l: string) => l.length > 5);
    return lines.slice(0, 5);
  } catch (e) {
    console.error("News headlines fetch failed:", (e as Error).message);
    return [];
  }
}

async function callGemini(prompt: string): Promise<string> {
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: attempt === 1 ? 0.7 : 0.3,
          maxOutputTokens: 2560,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!res.ok) {
      console.error(`Gemini API error (attempt ${attempt}):`, res.status);
      if (attempt === MAX_ATTEMPTS) throw new Error(`Gemini API failed: ${res.status}`);
      continue;
    }

    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const textParts = parts.filter((p: { text?: string }) => p.text);
    const rawText = textParts.length > 0 ? textParts[textParts.length - 1].text : null;

    if (!rawText) {
      if (attempt === MAX_ATTEMPTS) throw new Error("Empty Gemini response");
      continue;
    }

    try {
      const parsed = JSON.parse(rawText);
      return parsed.content || "";
    } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return parsed.content || "";
        } catch {
          if (attempt === MAX_ATTEMPTS) throw new Error("Invalid Gemini JSON");
          continue;
        }
      }
      if (attempt === MAX_ATTEMPTS) throw new Error("No JSON in Gemini response");
    }
  }

  throw new Error("Gemini call exhausted all attempts");
}

// ===== Main route =====

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("daily-analysis");
  const supabase = supabaseAdmin;

  try {
    const todayISO = getKSTDate();
    const yesterdayISO = getKSTDate(-1);
    const yesterdayKbo = toKboDate(yesterdayISO);

    // 1. Fetch current data in parallel
    const [standings, games, batterEntries, pitcherEntries] = await Promise.all([
      fetchStandings(),
      fetchGames(yesterdayKbo),
      fetchBatterTitleEntries(),
      fetchPitcherTitleEntries(),
    ]);

    // 2. Fetch yesterday's snapshots
    const [{ data: yesterdayStandings }, { data: yesterdayStats }] = await Promise.all([
      supabase.from("daily_standings_snapshot").select("*").eq("date", yesterdayISO),
      supabase.from("daily_stats_snapshot").select("*").eq("date", yesterdayISO),
    ]);

    // 3. Build team name map
    const teamNames = new Map(TEAMS.map((t) => [t.id, t.shortName]));

    // 4. Compute streaks and build today's standings snapshot
    const standingsSorted = [...standings].sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      return a.gamesBehind - b.gamesBehind;
    });

    const yesterdayStreakMap = new Map(
      (yesterdayStandings ?? []).map((s: StandingsSnapshot) => [s.team_id, s.streak]),
    );

    const todayStandingsSnapshots: StandingsSnapshot[] = standingsSorted.map((s, i) => ({
      date: todayISO,
      team_id: s.teamId,
      rank: i + 1,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      win_rate: s.winRate,
      games_behind: s.gamesBehind,
      streak: computeStreak(s.teamId, games, yesterdayStreakMap.get(s.teamId) ?? null),
    }));

    // 5. Build today's stats snapshot
    const todayStatsSnapshots: StatsSnapshotRow[] = [...batterEntries, ...pitcherEntries].map((e) => ({
      date: todayISO,
      category: e.category,
      rank: e.rank,
      player_name: e.player_name,
      team: e.team,
      value: e.value,
    }));

    // 6. Save today's snapshots
    const { error: standingsErr } = await supabase
      .from("daily_standings_snapshot")
      .upsert(todayStandingsSnapshots, { onConflict: "date,team_id" });

    const { error: statsErr } = await supabase
      .from("daily_stats_snapshot")
      .upsert(todayStatsSnapshots, { onConflict: "date,category,player_name,team" });

    if (standingsErr) console.error("Standings snapshot upsert error:", standingsErr.message);
    if (statsErr) console.error("Stats snapshot upsert error:", statsErr.message);

    // 7. Check if yesterday data exists — if not, skip analysis (first run)
    const hasYesterdayStandings = !!yesterdayStandings?.length;
    const hasYesterdayStats = !!yesterdayStats?.length;
    if (!hasYesterdayStandings && !hasYesterdayStats) {
      const msg = "첫 실행: 어제 스냅샷 없음 — 스냅샷만 저장, 분석 skip";
      await finishJob(logId, "success", msg);
      return NextResponse.json({ ok: true, message: msg, snapshotsOnly: true });
    }

    // 8. Check if games were played
    const finalGames = games.filter((g) => g.status === "final");
    const noGames = finalGames.length === 0;

    // 9. Compute deltas
    const gameEvents = extractGameEvents(games);

    // 9a. Fetch box scores for finished games
    const boxScoreResults = await Promise.allSettled(
      finalGames.map((g) => fetchBoxScore(g.gameId).then((bs) => [g.gameId, bs] as const)),
    );
    const boxScores = new Map<string, BoxScoreResult>();
    for (const r of boxScoreResults) {
      if (r.status === "fulfilled" && r.value[1]) {
        boxScores.set(r.value[0], r.value[1]);
      }
    }

    const standingsDelta = computeStandingsDelta(todayStandingsSnapshots, yesterdayStandings as StandingsSnapshot[]);

    const batterCats = ["avg", "hr", "rbi", "sb"];
    const pitcherCats = ["era", "wins", "k", "saves", "whip"];
    const todayBatterStats = todayStatsSnapshots.filter((s) => batterCats.includes(s.category));
    const todayPitcherStats = todayStatsSnapshots.filter((s) => pitcherCats.includes(s.category));
    const yesterdayBatterStats = ((yesterdayStats ?? []) as StatsSnapshotRow[]).filter((s) => batterCats.includes(s.category));
    const yesterdayPitcherStats = ((yesterdayStats ?? []) as StatsSnapshotRow[]).filter((s) => pitcherCats.includes(s.category));

    const batterDelta = computeTitlesDelta(todayBatterStats, yesterdayBatterStats);
    const pitcherDelta = computeTitlesDelta(todayPitcherStats, yesterdayPitcherStats);

    // 9b. Extract highlights
    const gameHighlights = extractHighlights(gameEvents, boxScores, todayStandingsSnapshots, teamNames);

    // 10. Generate narratives with Gemini (or skip if no Gemini key)
    let standingsCopy = "";
    let batterCopy = "";
    let pitcherCopy = "";

    if (noGames) {
      // 경기 없는 날: 어제 분석을 그대로 유지하고 스냅샷만 갱신
      const { data: lastAnalysis } = await supabase
        .from("daily_analysis")
        .select("type, generated_copy, delta_json")
        .eq("date", yesterdayISO);

      if (lastAnalysis?.length) {
        // 어제 분석을 오늘 날짜로 복사 + 업데이트 일자 표시
        const lastMap = new Map(lastAnalysis.map((r: { type: string; generated_copy: string; delta_json: unknown }) => [r.type, r]));
        const lastStandings = lastMap.get("standings");
        const lastBatter = lastMap.get("batter_titles");
        const lastPitcher = lastMap.get("pitcher_titles");
        standingsCopy = lastStandings?.generated_copy ?? "";
        batterCopy = lastBatter?.generated_copy ?? "";
        pitcherCopy = lastPitcher?.generated_copy ?? "";
        // delta_json에 경기 없음 표시 추가
        Object.assign(standingsDelta, { noGames: true, lastUpdated: yesterdayISO });
        Object.assign(batterDelta, { noGames: true, lastUpdated: yesterdayISO });
        Object.assign(pitcherDelta, { noGames: true, lastUpdated: yesterdayISO });
      } else {
        standingsCopy = "";
        batterCopy = "";
        pitcherCopy = "";
      }
    } else if (GEMINI_API_KEY) {
      // 뉴스 헤드라인 가져오기 (Google Search grounding)
      const newsHeadlines = await fetchNewsHeadlines(yesterdayISO);
      console.log(`News headlines (${newsHeadlines.length}):`, newsHeadlines);
      const promises: Promise<string>[] = [];
      // 순위 분석: 어제 순위 스냅샷이 있으면 생성
      promises.push(hasYesterdayStandings
        ? callGemini(buildStandingsPrompt(standingsDelta, gameEvents, teamNames, gameHighlights, newsHeadlines, boxScores))
        : Promise.resolve(""));
      // 타자/투수 분석: 어제 스탯 스냅샷이 있으면 생성
      promises.push(hasYesterdayStats
        ? callGemini(buildTitlePrompt(batterDelta, gameEvents, "batter"))
        : Promise.resolve(""));
      promises.push(hasYesterdayStats
        ? callGemini(buildTitlePrompt(pitcherDelta, gameEvents, "pitcher"))
        : Promise.resolve(""));
      [standingsCopy, batterCopy, pitcherCopy] = await Promise.all(promises);
    } else {
      standingsCopy = standingsDelta.summary;
      batterCopy = batterDelta.summary;
      pitcherCopy = pitcherDelta.summary;
    }

    // 11. Save analysis results
    const analysisRows = [
      {
        date: todayISO,
        type: "standings",
        delta_json: { ...standingsDelta, _highlights: gameHighlights.map(h => h.text) },
        generated_copy: standingsCopy,
        prompt_version: PROMPT_VERSION,
        created_at: new Date().toISOString(),
      },
      {
        date: todayISO,
        type: "batter_titles",
        delta_json: batterDelta,
        generated_copy: batterCopy,
        prompt_version: PROMPT_VERSION,
        created_at: new Date().toISOString(),
      },
      {
        date: todayISO,
        type: "pitcher_titles",
        delta_json: pitcherDelta,
        generated_copy: pitcherCopy,
        prompt_version: PROMPT_VERSION,
        created_at: new Date().toISOString(),
      },
    ];

    const { error: analysisErr } = await supabase
      .from("daily_analysis")
      .upsert(analysisRows, { onConflict: "date,type" });

    if (analysisErr) {
      await finishJob(logId, "error", "분석 저장 실패", analysisErr.message);
      return NextResponse.json({ error: analysisErr.message }, { status: 500 });
    }

    const summary = `${todayISO} 분석 완료: ${finalGames.length}경기, ${standingsDelta.summary}, ${batterDelta.summary}`;
    await finishJob(logId, "success", summary);

    return NextResponse.json({
      ok: true,
      date: todayISO,
      gamesAnalyzed: finalGames.length,
      standingsDelta: standingsDelta.summary,
      batterDelta: batterDelta.summary,
      pitcherDelta: pitcherDelta.summary,
    });
  } catch (e) {
    const msg = (e as Error).message;
    await finishJob(logId, "error", undefined, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
