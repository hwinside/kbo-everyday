// 팀별 뉴스클리핑 빌더 — 어제(KST) 팀 기사 수집 → 뉴스카드와 동일한 관련성
// 가드/중복 제거 → Gemini가 주요 5개 선정 + 기사당 3줄 요약 + 데일리 총평.
// 소비자: /api/cron/news-clipping (매일 09:00 KST 쪽지 발송).
//
// 요약 입력은 네이버 제목+description 스니펫만 사용 (기사 풀본문 크롤은 언론사
// 약관 리스크로 v1 제외 — 스니펫만으로 실질 요약이 안 나오는 기사는 Gemini가
// 선정하지 않도록 프롬프트로 게이트, 삼순 조건).

import type { NewsItem } from "@/types/api";
import type {
  NewsClippingArticle,
  NewsClippingLegacyPayload,
  NewsClippingRefPayload,
} from "@/types/news-clipping";
import { toPushPreview as makePushPreview } from "@/types/news-clipping";
import {
  TEAM_SEARCH,
  fetchNaverNews,
  fetchNaverNewsPage,
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

/**
 * 야잘알봇 RAG 적재용 raw 후보 싱크.
 * 클리핑 필터를 통과하기 **전** 어제치 기사 전량을 받는다.
 * 싱크가 예외를 던져도 클리핑 발송은 멈추지 않는다(호출측에서 fail-open) —
 * 근거 적재는 부가기능이며 유저 발송을 깨뜨릴 사유가 아니다.
 *
 * `meta.truncated` 는 네이버 페이지 상한(2페이지)까지 다 받고도 마지막 항목이 여전히
 * 어제치인 경우 — 즉 못 본 기사가 남았을 가능성 — 를 뜻한다. 사후에 "그날 근거가
 * 없다" 와 "그날 근거를 다 못 가져왔다" 를 구분하기 위해 커버리지 원장에 기록한다.
 */
export interface RawCandidateMeta {
  truncated: boolean;
  pagesFetched: number;
}

export type RawCandidateSink = (teamId: number, items: NewsItem[], meta: RawCandidateMeta) => void;

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
async function collectYesterdayCandidates(
  teamShort: string,
  teamId: number,
  yesterday: string,
  onRawCandidates?: RawCandidateSink,
): Promise<NewsItem[]> {
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

  // 야잘알봇 RAG 적재 분기 — **야구 관련성 가드는 통과시키고, 카드 전용 필터만 우회**한다.
  //
  // 우회하는 것 (카드 품질 기준이라 근거로는 과하다)
  //   · isPhotoArticle / isOtherTeamTitle / hasClippingTitleSignal
  //     `선두 KT, 한화 12-1 완파…(종합)` 은 isOtherTeamTitle 에 걸려 카드에서 빠지지만
  //     "어제 두산:LG 3피트 논란" 의 실제 근거 문장을 담고 있다(실측).
  //
  // 통과시키는 것 (근거 오염 방지 — 삼순 NO-GO)
  //   · isTeamBaseballRelevant : 야구 관련성 + NON_BASEBALL_NEGATIVE 차단
  //     이걸 건너뛰면 2026-07-19 실재 회귀(여자골프 기사 속 'LG 트윈스 김진성')가
  //     그대로 RAG 원장에 들어가 야잘알봇이 골프 기사를 야구 근거로 인용한다.
  //     카드에 안 나가니 눈에 안 띄고, 답변 품질만 조용히 썩는다.
  if (onRawCandidates) {
    const rawSeen = new Set<string>();
    const raw = pages.flat().filter((item) => {
      if (rawSeen.has(item.link)) return false;
      rawSeen.add(item.link);
      if (pubDateToKstDate(item.pubDate) !== yesterday) return false;
      return isTeamBaseballRelevant(item.title, item.description, mascot);
    });
    // 마지막으로 받은 페이지의 끝까지 어제치면 그 뒤로 더 있었다는 뜻 — 상한 절단.
    const lastItem = pages[pages.length - 1]?.[pages[pages.length - 1].length - 1];
    const truncated = Boolean(lastItem) && (pubDateToKstDate(lastItem!.pubDate) ?? "") >= yesterday;
    onRawCandidates(teamId, raw, { truncated, pagesFetched: pages.length });
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
- overview에서 서로 무관한 사실을 인과·양보 어미("~하며", "~했지만", "~덕분에", "~지켰고" 등)로 잘못 엮지 말 것 — 특히 승패와 순위는 별개 사실이다. 패배가 순위 유지·상승의 이유인 것처럼(예: "대패하며 3위를 지켰고") 서술 금지. 여러 이슈는 인과관계를 지어내지 말고 담백하게 병렬로 나열하라

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
 * 백필용 raw 후보 수집 — **발송과 무관**하다. 클리핑 로직을 한 줄도 타지 않는다.
 *
 * 왜 별도 함수인가
 *   일일 cron 은 "어제 하루치" 만 본다(2페이지). 그래서 배포 직후에는 근거가 하루치뿐이고
 *   창이 차기까지 그만큼 기다려야 한다. 야잘알봇 출시 판정을 그때까지 미룰 수 없다.
 *
 * 결과창 한계와 fan-out (2026-08-07 실측, 추정 아님)
 *   네이버 검색은 `start` 상한이 1000 이라 **쿼리 하나당 최대 1,000건**이다. 그 1,000건이
 *   며칠 치인지는 그 쿼리의 총 건수에 반비례한다:
 *     · `프로야구 LG 트윈스`    total 460,259 → 07-29 (약 9일)   ❌
 *     · `LG 트윈스 경기`        total 1,004,928 → 08-02          ❌
 *     · `LG 트윈스 불펜`        total 85,027  → 07-13            ✅
 *     · `LG 트윈스 부상`        total 85,805  → 07-09            ✅
 *     · `프로야구 LG 트윈스 패배` total 20,628  → 04-01            ✅
 *   즉 **좁은 쿼리일수록 과거로 깊이 들어간다.** 그래서 broad 쿼리로 먼저 긁고, 창을 다 못
 *   덮은 팀만 좁은 쿼리를 순차로 더해 채운다(이미 닿은 팀은 추가 호출 0).
 *
 * ⚠️ 표기 주의 — 이것은 "N일 전수 기사" 가 아니라 **"N일 범위 확보"** 다.
 *   좁은 쿼리는 그 키워드에 걸리는 기사만 가져오므로 그 날의 모든 기사가 아니다.
 *   커버리지 원장에도 같은 의미로 기록한다.
 */
export const NAVER_BACKFILL_MAX_START = 901;

/**
 * 창을 못 덮었을 때 순서대로 추가 투입하는 좁은 쿼리 접미사.
 * 총 건수가 적은(=깊이 들어가는) 것부터 놓아 최소 호출로 창을 채운다 — 위 실측 순서.
 */
export const BACKFILL_FANOUT_SUFFIXES = ["패배", "승리", "부상", "불펜", "타선", "감독"] as const;

export interface BackfillDayResult {
  /** KST YYYY-MM-DD */
  clipDate: string;
  items: NewsItem[];
}

export interface BackfillCollection {
  days: BackfillDayResult[];
  pagesFetched: number;
  /** 마지막 쿼리까지 쓰고도 창을 다 못 덮었는가 — 그 아래 날짜는 근거가 없는 게 아니라 못 닿은 것. */
  reachedApiLimit: boolean;
  /** 실제로 닿은 가장 오래된 KST 날짜. 하나도 못 닿았으면 null. */
  oldestReached: string | null;
  /** 이 팀에 실제로 쓴 쿼리 수(broad 1 + fan-out N). 1이면 broad 하나로 충분했다는 뜻. */
  queriesUsed: number;
  /**
   * 실제로 기사를 관측한 KST 날짜 집합.
   * sparse 한 fan-out 쿼리는 며칠씩 건너뛰며 과거를 찍으므로, 여기 없는 날짜는
   * "기사가 0건" 이 아니라 **"안 본 날"** 이다. 커버리지 원장이 둘을 구분하는 근거가 된다.
   */
  observedDays: Set<string>;
  /** 예산이 끊어 수집을 중단했는가. true 면 이 팀의 결과는 **부분**이다. */
  deadlineHit: boolean;
}

/**
 * 쿼리 하나를 결과창 끝까지(또는 창을 덮을 때까지) 훑는다.
 *
 * 세 가지가 미묘하다 (전부 삼순 NO-GO 로 잡힌 실제 결함)
 *   1. **relevance 가드는 여기서도 돈다.** 일일 sink 만 고치면 백필이 여자골프·증시 기사를
 *      그대로 원장에 밀어넣는다. 백필은 한 번에 수천 건을 넣으므로 오염 규모가 더 크다.
 *   2. **페이지 종료는 원응답 개수로 판정한다.** fetchNaverNews 는 비네이버 기사를 걸러내므로
 *      100건 중 1건만 탈락해도 `items.length < 100` 이 되어 조기 종료했다.
 *   3. **관측한 날짜를 기록한다.** sparse 한 fan-out 쿼리(예: `LG 트윈스 부상`)는 며칠씩
 *      건너뛰며 과거를 찍는다. 건너뛴 날짜를 "기사 0건" 으로 두면 안 되고 "안 본 날" 이어야 한다.
 */
async function scanQuery(
  query: string,
  sinceDate: string,
  untilDate: string,
  mascot: string | null,
  byDate: Map<string, NewsItem[]>,
  seen: Set<string>,
  observedDays: Set<string>,
  deadlineAt: number,
): Promise<{ pages: number; coveredWindow: boolean; oldest: string | null; deadlineHit: boolean }> {
  let pages = 0;
  let coveredWindow = false;
  let oldest: string | null = null;

  for (let start = 1; start <= NAVER_BACKFILL_MAX_START; start += 100) {
    // **페이지 루프 안에서** 예산을 본다. 팀 시작 전에만 검사하면 한 팀이 일단 들어간 뒤
    // 7쿼리 × 10페이지 × 8초 ≈ 560초를 계속 돌아 route maxDuration 을 넘긴다(삼순 NO-GO).
    if (Date.now() >= deadlineAt) return { pages, coveredWindow, oldest, deadlineHit: true };
    const { items, rawCount } = await fetchNaverNewsPage(query, start, 100);
    pages += 1;
    if (rawCount === 0) break;

    for (const item of items) {
      const day = pubDateToKstDate(item.pubDate);
      if (!day) continue;
      if (day > untilDate) continue; // 아직 요청 창에 못 들어온 최신 기사
      if (day < sinceDate) {
        // date desc 정렬이라 창보다 오래된 게 나오면 이 쿼리는 창을 다 덮은 것이다.
        coveredWindow = true;
        continue;
      }
      if (!oldest || day < oldest) oldest = day;
      // 이 날짜의 기사를 실제로 눈으로 봤다 — 결과가 걸러져 0건이 되더라도 "본 날" 이다.
      observedDays.add(day);
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      // 근거 오염 방지 — 일일 sink 와 동일한 가드를 백필에도 적용한다.
      if (!isTeamBaseballRelevant(item.title, item.description, mascot)) continue;
      const bucket = byDate.get(day);
      if (bucket) bucket.push(item);
      else byDate.set(day, [item]);
    }

    if (coveredWindow) break;
    // **원응답**이 한 페이지를 못 채웠으면 이 쿼리는 고갈된 것이다.
    // 필터 후 개수로 판정하면 비네이버 1건 탈락에도 조기 종료해 과거를 통째로 놓친다.
    if (rawCount < 100) break;
  }

  return { pages, coveredWindow, oldest, deadlineHit: false };
}

export async function collectBackfillCandidates(
  teamShort: string,
  sinceDate: string,
  untilDate: string,
  /** 이 시각(epoch ms)을 넘기면 수집을 중단한다. 기본값은 사실상 무제한(테스트·수동 실행용). */
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<BackfillCollection> {
  const fullName = TEAM_SEARCH[teamShort] || teamShort;
  const mascot = fullName.split(/\s+/).pop() || null;

  const byDate = new Map<string, NewsItem[]>();
  const seen = new Set<string>();
  // 실제로 기사를 본 날짜. 여기 없는 날짜는 "기사 0건" 이 아니라 "안 본 날" 이다.
  const observedDays = new Set<string>();
  let pagesFetched = 0;
  let queriesUsed = 0;
  let oldestReached: string | null = null;
  let covered = false;
  let deadlineHit = false;

  // broad 쿼리 하나로 충분한 팀(기사량이 적은 팀)은 여기서 끝난다.
  const queries = [`프로야구 ${fullName}`, ...BACKFILL_FANOUT_SUFFIXES.map((s) => `${fullName} ${s}`)];

  for (const query of queries) {
    // 쿼리 경계에서도 본다 — 마지막 페이지가 예산을 다 쓴 채 끝났을 수 있다.
    if (Date.now() >= deadlineAt) { deadlineHit = true; break; }
    const result = await scanQuery(
      query, sinceDate, untilDate, mascot, byDate, seen, observedDays, deadlineAt,
    );
    pagesFetched += result.pages;
    queriesUsed += 1;
    if (result.oldest && (!oldestReached || result.oldest < oldestReached)) {
      oldestReached = result.oldest;
    }
    if (result.deadlineHit) { deadlineHit = true; break; }
    if (result.coveredWindow) {
      covered = true;
      break; // 창을 덮었으면 남은 fan-out 쿼리는 호출하지 않는다.
    }
  }

  return {
    days: [...byDate.entries()]
      .map(([clipDate, items]) => ({ clipDate, items }))
      .sort((a, b) => (a.clipDate < b.clipDate ? -1 : 1)),
    pagesFetched,
    reachedApiLimit: !covered,
    oldestReached,
    queriesUsed,
    observedDays,
    deadlineHit,
  };
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
  onRawCandidates?: RawCandidateSink,
  // 빌더는 항상 **legacy 형태**(articles 포함)를 만든다. 참조형 변환은 발송 직전
  // toRefClippingPayload 가 맡는다 — 그래야 샘플 발송·건수 집계 같은 기존 소비처가 그대로 동작하고,
  // digest upsert 실패 시 legacy 로 발송하는 폴백도 성립한다.
): Promise<NewsClippingLegacyPayload | null> {
  const yesterday = kstDateString(-1);

  const candidates = await collectYesterdayCandidates(teamShort, teamId, yesterday, onRawCandidates);
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

/**
 * 발송 직전 정규화: 기사 묶음을 digest 1행으로 올리고 쪽지에 넣을 참조형 payload 를 만든다.
 *
 * 이전엔 buildTeamClipping 이 만든 payload(평균 2KB, 그중 articles 가 3.5KB)를 수신자 수만큼
 * 그대로 복제해 dm_messages 에 넣었다 — 2026-08-20 실측으로 8/18 KIA 가 6,102행인데 서로 다른
 * payload 는 120개(중복률 98%)였고, 하루 27,208건 × 2KB ≈ 55MB/일 이 전부 이 복제다.
 *
 * digest upsert 가 실패하면 null 을 돌려 **호출부가 legacy 형태로 발송하게** 한다.
 * 정규화는 용량 최적화이지 기능이 아니다 — 여기서 던지면 그날 클리핑이 안 나간다.
 *
 * ⚠️ intro(유저별 닉네임 치환)는 digest 에 넣지 않는다. digest 는 (clip_date, team_id) 공유
 *    행이라 거기 넣으면 한 사람의 닉네임이 그 팀 전체에게 보인다. intro 는 쌍지 payload 단에 남는다.
 */
export async function toRefClippingPayload(
  admin: {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  },
  payload: NewsClippingLegacyPayload,
): Promise<NewsClippingRefPayload | null> {
  // ⚠️ 삼순 blocker 3 (2026-08-20): 1차는 호출부의 `clipDate`(= 오늘, kstDateString(0))를
  //    digest 에 넣고 쪽지 payload 에는 `payload.date`(= 어제, 기사 기준일)를 넣었다.
  //    같은 문서의 날짜 SSOT 가 하루 어긋나고, 클라가 digest.clip_date 로 폴백하는 순간
  //    헤더 날짜가 틀리게 된다. digest 는 "어느 날 기사 묶음인가"를 뜻하므로
  //    기준은 **기사 기준일(payload.date)** 이다. 발송일이 아니다.
  const { data, error } = await admin.rpc("upsert_news_clipping_digest", {
    p_clip_date: payload.date,
    p_team_id: payload.team_id,
    p_team_name: payload.team_name,
    p_overview: payload.overview,
    p_articles: payload.articles,
  });
  if (error) {
    console.error(
      `[news-clipping] digest upsert failed (team ${payload.team_id}) — legacy 형태로 발송:`,
      error.message,
    );
    return null;
  }
  const digestId = Number(data);
  if (!Number.isFinite(digestId) || digestId <= 0) {
    console.error(`[news-clipping] digest id 불량 (team ${payload.team_id}):`, data);
    return null;
  }
  return {
    type: "news_clipping",
    team_id: payload.team_id,
    team_name: payload.team_name,
    date: payload.date,
    digest_id: digestId,
    // ⚠️ 삼순 blocker 2: 참조형에 푸시 본문이 없으면 디스패쳐가 발송건마다 digest 를 재조회한다
    //    (하루 27,208건 = DB 조회 27,208회 추가). 짧은 미리보기만 실어보낸다 —
    //    전체 articles(3.5KB)는 여전히 digest 에만 있어 용량 이득은 유지된다.
    push_preview: makePushPreview(payload.overview),
  };
}
