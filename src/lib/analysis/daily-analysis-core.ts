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

// 임의 ISO 날짜에 일수 가감 (UTC 기준, tz drift 방지)
function isoAddDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

// Assign competition (tie-aware) ranks: equal values share the same rank,
// next distinct value jumps to (index+1). e.g. 5,5,5,4 -> 1,1,1,4.
// `lowerIsBetter` handles ERA/WHIP where smaller value = better rank.
function assignTieAwareRanks<T extends { value: number; rank: number }>(
  entries: T[],
  lowerIsBetter = false,
): T[] {
  const sorted = [...entries].sort((a, b) =>
    lowerIsBetter ? a.value - b.value : b.value - a.value,
  );
  let prevValue: number | null = null;
  let prevRank = 0;
  sorted.forEach((e, i) => {
    if (prevValue !== null && e.value === prevValue) {
      e.rank = prevRank;
    } else {
      e.rank = i + 1;
      prevRank = i + 1;
      prevValue = e.value;
    }
  });
  return sorted;
}

async function fetchBatterTitleEntries(): Promise<TitleEntry[]> {
  const entries: TitleEntry[] = [];

  for (const title of BATTER_TITLES) {
    const catEntries: TitleEntry[] = [];
    if (title.category === "sb") {
      const html = await fetchHtml(`${KBO_BASE}/Record/Player/Runner/Basic.aspx?sort=SB_CN`);
      const rows = parseTable(html);
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const c = rows[i];
        catEntries.push({
          category: "sb",
          rank: 0, // filled below
          player_name: c[1] || "",
          team: c[2] || "",
          value: parseInt(c[3]) || 0, // SB column in Runner page
        });
      }
    } else {
      const html = await fetchHtml(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=${title.sort}`);
      const rows = parseTable(html);
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const c = rows[i];
        const raw = c[title.colIndex] || "0";
        catEntries.push({
          category: title.category,
          rank: 0,
          player_name: c[1] || "",
          team: c[2] || "",
          value: parseFloat(raw) || 0,
        });
      }
    }
    entries.push(...assignTieAwareRanks(catEntries));
  }

  return entries;
}

async function fetchPitcherTitleEntries(): Promise<TitleEntry[]> {
  const entries: TitleEntry[] = [];

  for (const title of PITCHER_TITLES) {
    const html = await fetchHtml(`${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=${title.sort}`);
    const rows = parseTable(html);
    const catEntries: TitleEntry[] = [];
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const c = rows[i];
      const raw = c[title.colIndex] || "0";
      catEntries.push({
        category: title.category,
        rank: 0,
        player_name: c[1] || "",
        team: c[2] || "",
        value: parseFloat(raw) || 0,
      });
    }
    // ERA/WHIP: lower is better
    const lowerIsBetter = title.category === "era" || title.category === "whip";
    entries.push(...assignTieAwareRanks(catEntries, lowerIsBetter));
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

  const allDeltas = [...delta.top, ...delta.mid, ...delta.bottom];
  // 공동 순위 그룹 감지 (newRank 기준)
  const rankGroups = new Map<number, number>();
  for (const d of allDeltas) rankGroups.set(d.newRank, (rankGroups.get(d.newRank) ?? 0) + 1);
  const teamDeltas = allDeltas.map((d) => {
    const name = teamNames.get(d.team_id) || `팀${d.team_id}`;
    const change = d.rankChange > 0 ? `↑${d.rankChange}` : d.rankChange < 0 ? `↓${Math.abs(d.rankChange)}` : "-";
    const streakNum = parseInt(d.streak || "0");
    const streakText = Math.abs(streakNum) >= 3 ? `${Math.abs(streakNum)}${streakNum > 0 ? "연승" : "연패"} 중` : "";
    const isTie = (rankGroups.get(d.newRank) ?? 0) > 1;
    const newRankLabel = isTie ? `공동 ${d.newRank}위` : `${d.newRank}위`;
    const rankInfo = d.rankChange !== 0 ? `${d.oldRank}위→${newRankLabel}(${change})` : `${newRankLabel}(변동없음)`;
    return `${rankInfo} ${name}: ${d.wins}승${d.losses}패${d.draws}무 (${d.games_behind}게임차)${streakText ? `, ${streakText}` : ""}`;
  }).join("\n");

  return `당신은 KBO 프로야구 전문 데이터 분석 기자입니다.
아래 데이터를 바탕으로 최근 경기 기준 순위 동향을 기사체 반말(~다)로 작성하세요.

## 핵심 원칙
0. 존댓말(~습니다/~합니다) 절대 금지. 기사체 반말(~했다/~됐다/~있다)로만 작성하세요.
1. 제공된 데이터 외의 정보를 사용하지 마세요.
2. 시점 표현 규칙: "오늘", "어제" 등 시점 부사를 본문에 절대 쓰지 마세요. 경기 날짜는 화면에 별도로 표기되므로 본문에는 시점어 없이 사건만 서술하세요. "4월 17일" 등 구체적 날짜도 금지.
2-1. 금지 도입부 예시 (절대 쓰지 말 것): "어제 KBO리그는~", "오늘 KBO에서는~", "어제 경기에서는~", "오늘의 순위는~". 도입부는 시점어 없이 바로 사건부터 시작하세요. 예: "KT가 키움을 5대0으로 완파하며 3연승을 달렸다".
3. 마크다운/HTML 문법 금지. ##, **, *, - 등 서식 없이 순수 텍스트로만 작성.
4. 승률은 언급하지 마세요.
5. 3연승/3연패 미만의 streak는 언급하지 마세요.
6. 상위권/중위권/하위권으로 나누지 말고, 순위 변동 팀 중심으로 서술. 변동 없는 팀은 생략.
7. "순위표 해설"이 아니라 "KBO에서 무슨 일이 있었는지" 요약하는 느낌으로.
8. 총론/도입부 없이 바로 핵심 사건부터 시작하는 것이 가장 좋습니다. 예: "KT가 키움을 5대0으로 완파하며 3연승을 달렸다" 처럼 바로 사건부터.
9. 언급 팀은 최대 3~4팀으로 제한. 나머지는 과감히 생략.
10. 순위 변동 정확성 필수: 데이터에 X위→Y위로 명시되어 있으니 반드시 그대로 사용. 올랐다/떨어졌다는 실제 순위 변동이 있을 때만. 변동없음이면 X위를 유지했다로 쓰세요.
10-1. 몇 위인지는 오직 '현재 순위' 섹션의 데이터만 근거로 쓰세요. 경기 스코어/승패/연승연패로 "~가 1위" 같은 판단을 직접 추론하지 마세요. 승리한 팀이 자동으로 1위가 되는 게 아닙니다.
10-2. 제공된 snapshot/rank/경기 데이터 바깥 정보를 절대 끌어들이지 마세요. 외부 상식·과거 이력·소속신뢰 추론 금지.
11. 선수 이름 필수: 본문에 선수명을 최소 1~2명 포함하세요. 팀 단위만 쓰면 AI 느낌이 납니다.
12. 승리투수 = 경기 주인공이 아닙니다. 승리투수라는 이유만으로 호투로 이겼다 금지. 선발이 5이닝+ 투구했으면 선발 서사 우선. 결승타/만루포 친 타자가 있으면 타자 서사 우선.
13. 뉴스 헤드라인 반드시 반영: 헤드라인 중 최소 1개는 구체적 사건으로 본문에 녹여야 합니다. 선수명 언급된 뉴스 우선.
13. 스코어/순위 팩트는 반드시 위 경기 데이터 기준. 뉴스는 맥락 보강용.
14. 이벤트가 없으면 순위 변동만으로 서술.
15. 동률 처리 필수: 데이터에 "공동 N위"로 표기된 팀은 반드시 "공동 N위"로 서술하세요. 순서만 나열해서 단독 N위처럼 만들지 마세요. 예: "공동 2위 LG, 공동 2위 KIA" → "LG와 KIA가 공동 2위를 다투고 있다" 형태로 묶거나, 다르게 언급할 때도 반드시 "공동" 접두어 유지.

## 경기 결과
${eventLines || "경기 없음"}

## 현재 순위 (변동 포함)
${teamDeltas}

${highlights.length > 0 ? `## 주요 이벤트\n${highlights.map((h) => `- ${h.team} ${h.text}`).join("\n")}\n\n` : ""}${newsHeadlines.length > 0 ? `## 뉴스 헤드라인 (맥락 보강용, 팩트는 위 데이터 기준)\n${newsHeadlines.map((h) => `- ${h}`).join("\n")}\n\n` : ""}## 출력 형식 (JSON 객체 하나만 출력)
{ "content": "KBO 전체 조망 요약 (시점어 없이, 순위 변동팀 중심, 150~250자, 마크다운/날짜 금지)" }`;
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
      // 공동 1위 감지: top5 중 rank === 1 인 모든 선수
      const coLeaders = c.top5.filter((p) => p.rank === 1);
      let leader: string;
      if (coLeaders.length > 1) {
        const names = coLeaders.map((p) => `${p.player_name}(${p.team})`).join(", ");
        leader = `공동 1위 (${coLeaders.length}명, ${c.newLeader.value}): ${names}`;
      } else if (c.leaderChanged) {
        leader = `1위 교체: ${c.oldLeader?.player_name}(${c.oldLeader?.team}) → ${c.newLeader.player_name}(${c.newLeader.team})`;
      } else {
        leader = `1위 유지: ${c.newLeader.player_name}(${c.newLeader.team}, ${c.newLeader.value})`;
      }
      const top5 = c.top5.map((p) => {
        const rc = p.rankChange > 0 ? `↑${p.rankChange}` : p.rankChange < 0 ? `↓${Math.abs(p.rankChange)}` : "-";
        return `  ${p.rank}위 ${p.player_name}(${p.team}) ${p.value} [순위변동: ${rc}]`;
      }).join("\n");
      return `### ${name}\n${leader}\n${top5}`;
    }).join("\n\n");

  return `당신은 KBO 프로야구 전문 데이터 분석 기자입니다.
아래 데이터를 바탕으로 최근 경기 기준 ${label} 변동을 기사체 반말(~다)로 작성하세요.

## 핵심 원칙
0. 존댓말(~습니다/~합니다) 절대 금지. 기사체 반말(~했다/~됐다/~있다)로만 작성하세요.
1. 제공된 데이터 외의 정보를 사용하지 마세요.
2. 시점 표현 규칙: "오늘", "어제" 등 시점 부사를 본문에 절대 쓰지 마세요. 경기 날짜는 화면에 별도로 표기되므로 본문에는 시점어 없이 사건만 서술하세요. "4월 17일" 등 구체적 날짜도 금지.
2-1. 금지 도입부 예시: "어제 타자 타이틀은~", "오늘 투수 타이틀은~". 도입부는 시점어 없이 바로 사건부터 시작하세요.
3. 마크다운/HTML 문법 금지. ##, **, *, - 등 서식 없이 순수 텍스트로만 작성하세요.
4. 각 카테고리별 변동을 서술하되, 1위 교체가 있으면 중점적으로 다루세요.
5. 경기 결과와 연결해서 왜 수치가 변했는지 설명하세요.
6. 구체적 수치를 자연스럽게 녹여 서술하세요.
7. 동률 처리 필수: 데이터에 순위가 명시되어 있으므로 그대로 따르세요. 같은 순위(예: 1위 여러 명)는 반드시 "공동 1위"로 묶어서 한 문장으로 서술하고, 절대 1위/2위/3위로 임의 서열화하지 마세요. 예: 홈런 5개 공동 1위 3명 → "오스틴, 장성우, 레이예스가 나란히 홈런 5개로 공동 1위에 올랐다".
8. 공동 N위가 여러 카테고리에 걸쳐 나오면 각각 동일 규칙 적용. 순위 숫자 앞에 "공동"을 반드시 붙이세요.

## 경기 결과
${eventLines || "경기 없음"}

## ${label} 변동
${catData}

## 출력 형식 (JSON 객체 하나만 출력)
{ "content": "${label} 변동 기사 본문 (시점어 없이, 150~250자, 마크다운 금지, 날짜 언급 금지)" }`;
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

// ===== Post-process sanitizer =====
// 경기 날짜는 화면 배지가 책임지므로 본문에는 시점 부사(어제/오늘)를 두지 않는다.
// LLM이 강화된 프롬프트에도 가끔 시점어를 생성하고, 과거 생성분(휴식일 복사 포함)도
// 본문 곳곳에 "어제"가 남아 있을 수 있으므로 저장/반환 전 본문 전체에서 제거한다.
// 단어 경계로 토큰 단위만 제거하므로 "오늘날", "어제오늘" 같은 합성어는 보존된다.
function sanitizeCopy(copy: string): string {
  if (!copy) return copy;
  // 도입부 + 본문 전체의 시점 부사 제거.
  // 조사(은/는/이/가/의/도/만)·문장부호(,)가 붙은 형태도 함께 제거.
  // "오늘날", "어제오늘" 같은 합성어는 뒤에 [은|는|이|가|의|도|만|,|\s|$] 외 글자가 이어지므로 매칭 안 됨 → 보존.
  // 뒤 공백은 소비하지 않아 "어제도 오늘은"처럼 연속된 시점어도 모두 제거한다.
  return copy
    .trimStart()
    .replace(/(^|\s)(어제|오늘)(은|는|이|가|의|도|만)?(,)?(?=\s|$)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ===== Core =====

/**
 * 일일 순위/타이틀 AI 분석 생성.
 *
 * mode="scheduled" (매일 01:00 크론, 백스톱): 어제 경기를 분석해 오늘 날짜로 저장 + 스냅샷 갱신.
 *   배지 = 저장일-1(=경기일). 기존 동작 그대로.
 * mode="live" (당일 경기 전부 종료 시 저녁 크론): 오늘 경기를 즉시 분석해 오늘 날짜로 저장.
 *   순위표 '오늘 결과 반영' 칩 기준 스냅샷을 깨지 않도록 스냅샷은 쓰지 않고,
 *   delta_json.lastUpdated=오늘 + sameDayLive=true 마커로 배지를 '오늘 경기 기준'으로 전환.
 *
 * 날짜 규약: daily_standings_snapshot date=X = "X일 경기 시작 전 누적"(=X-1까지 반영).
 *   따라서 gameDate 경기의 baseline(경기 전 상태) 스냅샷 = date=gameDate.
 *   scheduled의 gameDate=어제, live의 gameDate=오늘. 저장일은 두 모드 모두 오늘(=todayISO).
 */
export type DailyAnalysisMode = "scheduled" | "live";

export interface DailyAnalysisOutcome {
  status: number;
  body: Record<string, unknown>;
}

export async function runDailyAnalysis(mode: DailyAnalysisMode): Promise<DailyAnalysisOutcome> {
  const logId = await startJob(mode === "live" ? "daily-analysis-live" : "daily-analysis");
  const supabase = supabaseAdmin;

  try {
    const todayISO = getKSTDate();
    // baseline/게임일 = live면 오늘, scheduled면 어제. (yesterdayISO 이름은 하위 로직 호환 유지)
    const yesterdayISO = mode === "live" ? todayISO : getKSTDate(-1);
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

    // tie-aware rank: 승률+게임차가 모두 같을 때만 공동 순위 (거의 없지만 안전을 위해)
    const standingsWithRank: (typeof standingsSorted[number] & { rank: number })[] = [];
    let prevWr: number | null = null;
    let prevGb: number | null = null;
    let prevRank = 0;
    standingsSorted.forEach((s, i) => {
      const tie = prevWr !== null && s.winRate === prevWr && s.gamesBehind === prevGb;
      const rank = tie ? prevRank : i + 1;
      if (!tie) {
        prevRank = i + 1;
        prevWr = s.winRate;
        prevGb = s.gamesBehind;
      }
      standingsWithRank.push({ ...s, rank });
    });

    const todayStandingsSnapshots: StandingsSnapshot[] = standingsWithRank.map((s) => ({
      date: todayISO,
      team_id: s.teamId,
      rank: s.rank,
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
    //    live 모드는 스냅샷을 쓰지 않는다 — date=오늘 스냅샷은 '오늘 경기 전 누적' baseline이라
    //    순위표 '오늘 결과 반영됨' 칩(standings-snapshot 라우트)이 이 값을 기준으로 쓴다.
    //    저녁에 '경기 후' 누적으로 덮어쓰면 칩이 오작동하므로 스냅샷 저장은 scheduled(새벽)만 담당.
    if (mode === "scheduled") {
      const { error: standingsErr } = await supabase
        .from("daily_standings_snapshot")
        .upsert(todayStandingsSnapshots, { onConflict: "date,team_id" });

      const { error: statsErr } = await supabase
        .from("daily_stats_snapshot")
        .upsert(todayStatsSnapshots, { onConflict: "date,category,player_name,team" });

      if (standingsErr) console.error("Standings snapshot upsert error:", standingsErr.message);
      if (statsErr) console.error("Stats snapshot upsert error:", statsErr.message);
    }

    // 7. Check if yesterday data exists — if not, skip analysis (first run)
    const hasYesterdayStandings = !!yesterdayStandings?.length;
    const hasYesterdayStats = !!yesterdayStats?.length;
    if (!hasYesterdayStandings && !hasYesterdayStats) {
      const msg = mode === "live"
        ? "라이브: 경기 전 스냅샷 없음 — 분석 skip (새벽 백스톱 대기)"
        : "첫 실행: 어제 스냅샷 없음 — 스냅샷만 저장, 분석 skip";
      await finishJob(logId, "success", msg);
      return { status: 200, body: { ok: true, message: msg, snapshotsOnly: mode === "scheduled" } };
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
        // 직전 분석을 오늘 날짜로 복사 (시점어 제거) + 실제 마지막 경기일 표시
        const lastMap = new Map(lastAnalysis.map((r: { type: string; generated_copy: string; delta_json: unknown }) => [r.type, r]));
        const lastStandings = lastMap.get("standings");
        const lastBatter = lastMap.get("batter_titles");
        const lastPitcher = lastMap.get("pitcher_titles");
        standingsCopy = sanitizeCopy(lastStandings?.generated_copy ?? "");
        batterCopy = sanitizeCopy(lastBatter?.generated_copy ?? "");
        pitcherCopy = sanitizeCopy(lastPitcher?.generated_copy ?? "");
        // 실제 마지막 경기일 = 직전 분석의 경기일.
        // 직전 행이 이미 복사본(lastUpdated 보유)이면 그 값을, 아니면 직전 행 날짜의 하루 전(=직전 경기일).
        const srcDelta = (lastStandings?.delta_json ?? lastBatter?.delta_json ?? lastPitcher?.delta_json) as Record<string, unknown> | null;
        const sourceGameDate =
          (typeof srcDelta?.lastUpdated === "string" ? srcDelta.lastUpdated : null) ??
          isoAddDays(yesterdayISO, -1);
        // delta_json에 경기 없음 + 실제 마지막 경기일 표시
        Object.assign(standingsDelta, { noGames: true, lastUpdated: sourceGameDate });
        Object.assign(batterDelta, { noGames: true, lastUpdated: sourceGameDate });
        Object.assign(pitcherDelta, { noGames: true, lastUpdated: sourceGameDate });
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
      const [rawStandings, rawBatter, rawPitcher] = await Promise.all(promises);
      // Post-process 가드: LLM이 "어제/오늘" 시점어를 만들어도 저장 전에 본문 전체에서 제거
      standingsCopy = sanitizeCopy(rawStandings);
      batterCopy = sanitizeCopy(rawBatter);
      pitcherCopy = sanitizeCopy(rawPitcher);
    } else {
      standingsCopy = standingsDelta.summary;
      batterCopy = batterDelta.summary;
      pitcherCopy = pitcherDelta.summary;
    }

    // 11. Save analysis results
    //    live 모드: 배지를 '오늘 경기 기준'으로 전환(lastUpdated=오늘) + 멱등성 마커(sameDayLive).
    //    scheduled 모드: liveMeta 비어 있어 기존 동작 동일.
    const liveMeta = mode === "live" ? { lastUpdated: todayISO, sameDayLive: true } : {};
    const analysisRows = [
      {
        date: todayISO,
        type: "standings",
        delta_json: { ...standingsDelta, _highlights: gameHighlights.map(h => h.text), ...liveMeta },
        generated_copy: standingsCopy,
        prompt_version: PROMPT_VERSION,
        created_at: new Date().toISOString(),
      },
      {
        date: todayISO,
        type: "batter_titles",
        delta_json: { ...batterDelta, ...liveMeta },
        generated_copy: batterCopy,
        prompt_version: PROMPT_VERSION,
        created_at: new Date().toISOString(),
      },
      {
        date: todayISO,
        type: "pitcher_titles",
        delta_json: { ...pitcherDelta, ...liveMeta },
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
      return { status: 500, body: { error: analysisErr.message } };
    }

    const summary = `${todayISO} 분석 완료(${mode}): ${finalGames.length}경기, ${standingsDelta.summary}, ${batterDelta.summary}`;
    await finishJob(logId, "success", summary);

    return {
      status: 200,
      body: {
        ok: true,
        mode,
        date: todayISO,
        gamesAnalyzed: finalGames.length,
        standingsDelta: standingsDelta.summary,
        batterDelta: batterDelta.summary,
        pitcherDelta: pitcherDelta.summary,
      },
    };
  } catch (e) {
    const msg = (e as Error).message;
    await finishJob(logId, "error", undefined, msg);
    return { status: 500, body: { error: msg } };
  }
}
