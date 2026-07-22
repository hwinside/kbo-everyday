// 팀별 뉴스클리핑 빌더 — 어제(KST) 팀 기사 수집 → 뉴스카드와 동일한 관련성
// 가드/중복 제거 → Gemini가 주요 5개 선정 + 기사당 3줄 요약 + 데일리 총평.
// 소비자: /api/cron/news-clipping (매일 09:00 KST 쪽지 발송).
//
// 요약 입력은 네이버 제목+description 스니펫만 사용 (기사 풀본문 크롤은 언론사
// 약관 리스크로 v1 제외 — 스니펫만으로 실질 요약이 안 나오는 기사는 Gemini가
// 선정하지 않도록 프롬프트로 게이트, 삼순 조건).

import type { NewsItem } from "@/types/api";
import type { NewsClippingPayload, NewsClippingArticle } from "@/types/news-clipping";
import {
  TEAM_SEARCH,
  fetchNaverNews,
  fetchThumbnailUrl,
  mapWithConcurrency,
} from "@/lib/naver-news";
import {
  isTeamBaseballRelevant,
  isPhotoArticle,
  dedupeNewsByTitle,
  hasClippingTitleSignal,
  titleHasTeamToken,
} from "@/lib/news-relevance";
import { STANDINGS_ACCURACY_RULES, STANDINGS_UNAVAILABLE_RULES } from "@/lib/ai/standings-guard";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const MAX_PICKS = 5;
// Gemini 입력 후보 상한 — 프롬프트 길이/비용 억제. 하루 팀 기사가 이보다 많으면
// 최신순 상위만 후보로 쓴다 (Naver 결과가 date desc).
const MAX_CANDIDATES = 25;
const OG_CONCURRENCY = 4;

/** KST 기준 YYYY-MM-DD (offsetDays: -1 = 어제) */
export function kstDateString(offsetDays = 0): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function pubDateToKstDate(pubDate: string): string | null {
  const t = Date.parse(pubDate);
  if (Number.isNaN(t)) return null;
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 제목이 다른 팀 중심인 기사 판정 — 제목에 다른 팀 식별자(약칭/마스코트)만 있고 내 팀
 * 식별자가 없으면 관련성 가드(본문 언급)를 통과해도 팬 입장에선 남의 팀 기사로 보인다
 * (7/12 하린아빠 제보: LG 클리핑에 "한화 허인서…" 제목 기사 선정). 프롬프트 규칙만으론
 * Gemini가 안 따르는 케이스가 실측돼 코드 레벨 사전 필터로 차단. "LG, 한화 꺾고…"처럼
 * 내 팀이 함께 등장하는 맞대결 기사는 유지된다.
 */
// 팀 식별자 매칭은 hasClippingTitleSignal과 동일한 titleHasTeamToken(공유 helper)로
// 판정한다: Latin 약칭은 case-insensitive + ASCII 영숫자 경계, 한글 식별자는
// substring. 단순 lower-case includes를 쓰면 일반 영단어 속 약칭(algorithm→lg,
// encore→nc)이 target/other 양쪽을 오판정해 ①target 오판정으로 실제 타팀 검사를
// 건너뛰거나 ②other 오판정으로 정상 기사를 타팀으로 높리는 양방향 버그가
// 난다(2026-07-18 소문자 'kt' 타팀 통과 + 2026-07-19 algorithm/encore 오판정 — 삼순 NO-GO).
// hasClippingTitleSignal과 같은 규칙을 공유해 Latin 경계 판정이 두 게이트에서 일치한다.
export function isOtherTeamTitle(title: string, teamShort: string): boolean {
  const fullName = TEAM_SEARCH[teamShort] || teamShort;
  const targetTokens = [teamShort, ...fullName.split(/\s+/)];
  if (targetTokens.some((t) => titleHasTeamToken(title, t))) return false;
  for (const [short, full] of Object.entries(TEAM_SEARCH)) {
    if (short === teamShort) continue;
    const mascot = full.split(/\s+/).pop() || "";
    if (titleHasTeamToken(title, short) || (mascot && titleHasTeamToken(title, mascot))) return true;
  }
  return false;
}

// 팀별 로스터 선수명 — 클리핑 positive 제목 게이트용. 2자 이름(최정·곽빈 등)도
// 포함한다: substring 오탐("최정"→"최정상", "김건"→"김건희")은 hasClippingTitleSignal
// 의 토큰 경계 매칭으로 차단되므로 이름을 버리지 않고 recall을 살린다(2026-07-18
// SSG '최정 부상' 등 팀 핵심 이슈가 2자 제외로 누락 — 삼순 NO-GO).
function rosterTitleNames(teamId: number): string[] {
  return (PLAYERS_ROSTER as { name: string; teamId: number }[])
    .filter((p) => p.teamId === teamId)
    .map((p) => p.name);
}

/** 어제(KST) 보도된 팀 관련 기사 후보 수집 — 뉴스카드와 동일 가드 + 사진기사 제외 + 클리핑 제목 게이트 */
async function collectYesterdayCandidates(teamShort: string, teamId: number, yesterday: string): Promise<NewsItem[]> {
  const fullName = TEAM_SEARCH[teamShort] || teamShort;
  const mascot = fullName.split(/\s+/).pop() || null;
  const query = `프로야구 ${fullName}`;
  const teamTokens = [teamShort, ...fullName.split(/\s+/)];
  const rosterNames = rosterTitleNames(teamId);

  // 하루치 커버리지 확보 — display 최대(100) × 2페이지. 어제보다 오래된 기사가
  // 나오기 시작하면(date desc 정렬) 그 페이지에서 수집 종료.
  const pages: NewsItem[][] = [];
  for (const start of [1, 101]) {
    const items = await fetchNaverNews(query, start, 100);
    pages.push(items);
    const last = items[items.length - 1];
    if (!last || (pubDateToKstDate(last.pubDate) ?? "") < yesterday) break;
  }

  const seen = new Set<string>();
  const candidates = pages.flat().filter((item) => {
    if (seen.has(item.link)) return false;
    seen.add(item.link);
    if (pubDateToKstDate(item.pubDate) !== yesterday) return false;
    if (isPhotoArticle(item.title)) return false;
    if (isOtherTeamTitle(item.title, teamShort)) return false;
    if (!isTeamBaseballRelevant(item.title, item.description, mascot)) return false;
    // 클리핑 전용 positive 제목 게이트 — 제목에 팀/선수/야구 신호가 전혀 없는
    // off-topic 기사(본문만 팀 스침, 예: 여자골프 기사 속 'LG 트윈스 김진성')를
    // 원천 차단해 제목·사진과 요약이 어긋난 카드 방지.
    return hasClippingTitleSignal(item.title, teamTokens, rosterNames);
  });

  return dedupeNewsByTitle(candidates).slice(0, MAX_CANDIDATES);
}

interface GeminiPick {
  index: number;
  summary: string[];
}

interface GeminiSelection {
  overview: string;
  picks: GeminiPick[];
}

function buildPrompt(
  teamName: string,
  yesterday: string,
  candidates: NewsItem[],
  standingsText: string | null,
): string {
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.title}\n   ${c.description}`)
    .join("\n");

  // 순위표가 있으면 근거+정확성 규칙, 조회 실패면 순위 서술 금지 규칙을 넣는다.
  // (조회 실패 시에도 규칙을 넣어 근거 없는 순위 환각[3위 팀을 '선두'로 등]을 원천 차단.)
  const standingsBlock = standingsText
    ? `\n## 공식 순위표 (오늘 기준 — 순위 관련 서술의 유일한 근거)\n${standingsText}\n${STANDINGS_ACCURACY_RULES}\n`
    : `\n${STANDINGS_UNAVAILABLE_RULES}\n`;

  return `당신은 KBO 프로야구 "${teamName}" 팬을 위한 아침 뉴스클리핑 에디터입니다.
아래는 어제(${yesterday}) 보도된 ${teamName} 관련 기사 목록입니다 (번호. 제목 / 요약문).

${list}
${standingsBlock}
이 중 팬에게 중요한 순서로 최대 ${MAX_PICKS}개를 선정하고, 각 기사를 3줄로 요약하세요.

규칙:
- 같은 사건을 다룬 기사는 1개만 선정
- 제목의 주인공이 ${teamName}이 아닌 다른 팀이나 다른 팀 선수인 기사는 본문에 ${teamName}이 언급되더라도 선정하지 말 것 — 제목만 봐도 ${teamName} 팬을 위한 기사여야 함
- 각 줄은 완결된 한 문장, 간결한 뉴스체("~했다")
- 3줄 구성: ① 무슨 일이 있었는지 ② 구체적인 내용·수치 ③ 팀/팬 관점에서 갖는 의미
- 링크를 열지 않아도 기사 내용을 파악할 수 있어야 함
- 기사 내용은 제공된 제목/요약문에 있는 사실만 사용, 순위·승패·게임차 등 순위 정보는 (제공된 경우) 위 공식 순위표를 근거로 — 추측, 과장, 루머의 확정 표현 금지
- 제목 재작성이나 요약문 복사가 아니라 실질적인 내용 요약이어야 함
- 제공된 정보만으로 3줄 요약이 불가능한 기사는 선정하지 말 것
- overview: 어제 ${teamName} 주요 이슈를 팬에게 브리핑하는 한 문장

JSON으로만 응답:
{"overview": "...", "picks": [{"index": 기사번호, "summary": ["1줄", "2줄", "3줄"]}]}`;
}

function parseSelection(text: string, candidateCount: number): GeminiSelection | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { overview?: unknown; picks?: unknown };
  if (!Array.isArray(obj.picks)) return null;

  const seen = new Set<number>();
  const picks: GeminiPick[] = [];
  for (const p of obj.picks) {
    if (!p || typeof p !== "object") continue;
    const { index, summary } = p as { index?: unknown; summary?: unknown };
    const idx = typeof index === "number" ? Math.floor(index) : NaN;
    if (Number.isNaN(idx) || idx < 1 || idx > candidateCount || seen.has(idx)) continue;
    if (!Array.isArray(summary)) continue;
    const lines = summary.filter((l): l is string => typeof l === "string" && l.trim().length > 0).map((l) => l.trim());
    // 3줄 요약 필수 스펙 — 못 만든 기사는 클리핑에서 제외 (삼순 조건)
    if (lines.length < 3) continue;
    seen.add(idx);
    picks.push({ index: idx, summary: lines.slice(0, 3) });
    if (picks.length >= MAX_PICKS) break;
  }
  if (picks.length === 0) return null;

  return {
    overview: typeof obj.overview === "string" ? obj.overview.trim() : "",
    picks,
  };
}

async function selectAndSummarize(
  teamName: string,
  yesterday: string,
  candidates: NewsItem[],
  standingsText: string | null,
): Promise<GeminiSelection | null> {
  if (!GEMINI_API_KEY) {
    console.error("[news-clipping] GEMINI_API_KEY missing");
    return null;
  }
  const prompt = buildPrompt(teamName, yesterday, candidates, standingsText);

  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: attempt === 1 ? 0.4 : 0.2,
            maxOutputTokens: 3000,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        console.error(`[news-clipping] Gemini ${res.status} (attempt ${attempt})`);
        continue;
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text || "";
      const parsed = parseSelection(text, candidates.length);
      if (parsed) return parsed;
      console.error(`[news-clipping] Gemini parse failed (attempt ${attempt})`);
    } catch (e) {
      console.error(`[news-clipping] Gemini call failed (attempt ${attempt}):`, (e as Error).message);
    }
  }
  return null;
}

/**
 * 팀 하나의 클리핑 payload 생성.
 * 어제 기사 0개 또는 요약 가능 기사 0개면 null — 그 팀은 발송하지 않는다(빈 클리핑 금지).
 */
export async function buildTeamClipping(
  teamId: number,
  teamShort: string,
  teamName: string,
  standingsText: string | null = null,
): Promise<NewsClippingPayload | null> {
  const yesterday = kstDateString(-1);

  const candidates = await collectYesterdayCandidates(teamShort, teamId, yesterday);
  if (candidates.length === 0) return null;

  const selection = await selectAndSummarize(teamName, yesterday, candidates, standingsText);
  if (!selection) return null;

  // 선정된 기사에만 OG 썸네일 부착 (언론사 원문 기준 — /api/news와 동일)
  const picked = selection.picks.map((p) => ({ pick: p, item: candidates[p.index - 1] }));
  const thumbnails = await mapWithConcurrency(picked, OG_CONCURRENCY, ({ item }) =>
    fetchThumbnailUrl(item.originalLink || item.link),
  );

  const articles: NewsClippingArticle[] = picked.map(({ pick, item }, i) => ({
    title: item.title,
    link: item.link,
    original_link: item.originalLink || item.link,
    thumbnail_url: thumbnails[i] ?? null,
    summary: pick.summary,
  }));

  return {
    type: "news_clipping",
    team_id: teamId,
    team_name: teamName,
    date: yesterday,
    overview: selection.overview,
    articles,
  };
}
