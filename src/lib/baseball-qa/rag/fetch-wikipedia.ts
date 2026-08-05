/**
 * 한국어 위키피디아 수집 게이트 — **tier2 기본 소스** (R3, 2026-08-01, 하린아빠 지시).
 *
 * 왜 기본인가:
 *  - 공식 MediaWiki API를 **정직한 UA로 plain fetch**해 200을 받는다(브라우저 불필요, 16/16 실측).
 *    → Vercel 서버 런타임에서도 동작 가능한 유일한 tier2 경로다. 나무위키는 Playwright가 필요해
 *      수집 스크립트 전용이다.
 *  - `revid`가 API 응답에 있어 revision provenance가 **추정이 아니라 정본**이다(나무위키는 크롤 시각).
 *  - API가 `redirects`/`missing`/`pageid`를 명시해 canonical 확정 근거가 마크업 파싱보다 견고하다.
 *
 * 나무위키는 **보조**다: 별명·팬덤 서술 같은 디테일이 위키피디아에는 거의 없다
 * (실측: 위키피디아 평균 약 4천자, 별명 항목 대체로 없음 / 나무위키 문보경 문서에는 별명 서술 다수).
 *
 * 계약:
 *  (a) robots — API 경로(`/w/api.php`)는 ko.wikipedia.org robots.txt가 명시 허용한다. 확인기록을 남긴다.
 *  (b) 우회 금지 — 위장 UA·쿠키·로그인 없음. 정직한 자기식별 UA + bounded rate만 쓴다.
 *  (c) 최소 원문저장 — 이 모듈은 본문을 반환만 하고, 저장 단위는 chunk + provenance다.
 *  (d) canonical — `pageid`+정규화된 `title`로 canonical URL을 만들고, 동음이의/미존재는 거부한다.
 */

import { verifyPlayerDocumentIdentity, type PlayerDocumentIdentity } from "./canonical";
import { RAG_FETCH_TIMEOUT_MS, RAG_USER_AGENT } from "./fetch-namu";

export const WIKIPEDIA_HOST = "ko.wikipedia.org";
export const WIKIPEDIA_API_URL = `https://${WIKIPEDIA_HOST}/w/api.php`;
export const WIKIPEDIA_ROBOTS_URL = `https://${WIKIPEDIA_HOST}/robots.txt`;

export type WikipediaFetchResult =
  | {
      ok: true;
      /** 요청한 제목. */
      requestedTitle: string;
      /** API가 정규화/redirect 해석 후 돌려준 최종 문서 제목. */
      title: string;
      pageId: number;
      /** MediaWiki revision id — provenance의 정본이다. */
      revisionId: number;
      canonicalUrl: string;
      /** 판정 근거로 쓴 문서 분류 — provenance에 남긴다. */
      categories: string[];
      /** plaintext 본문(extracts). */
      extract: string;
      crawledAt: string;
    }
  | { ok: false; status: "missing" | "blocked" | "rejected"; reason: string };

export function wikipediaCanonicalUrl(title: string): string {
  return `https://${WIKIPEDIA_HOST}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/**
 * 동음이의 문서 판별(본문 리드 보조 신호).
 * ko.wikipedia는 동음이의 문서에 `분류:동음이의어 문서` 계열을 붙이고, 본문 첫 줄이
 * "…에는 다음과 같은 뜻이 있다" / "…은 다음 인물을 가리킨다" 형태다(실측: 박재현·한동희·구본혁·최민석).
 * 분류 대조는 `verifyPlayerDocumentIdentity`가 나무위키와 **같은 규칙**으로 수행한다.
 */
const DISAMBIGUATION_LEAD_PATTERNS = [
  /다음과 같은 뜻이 있다/,
  /다음 인물을 가리킨다/,
  /다음 사람을 가리킨다/,
  /다른 뜻은 다음과 같다/,
  /은\(는\) 다음을 가리킨다/,
];

export function isWikipediaDisambiguation(extract: string, categories: string[]): boolean {
  if (categories.some((category) => category.includes("동음이의"))) return true;
  const lead = extract.slice(0, 200);
  return DISAMBIGUATION_LEAD_PATTERNS.some((pattern) => pattern.test(lead));
}

interface WikipediaApiPage {
  pageid?: number;
  title?: string;
  missing?: string | boolean;
  extract?: string;
  revisions?: { revid?: number }[];
  categories?: { title?: string }[];
}

/**
 * 문서 1건을 공식 API로 가져온다.
 * plain fetch + 정직한 UA다 — 브라우저도, 위장도, 쿠키도 쓰지 않는다.
 */
export async function fetchWikipediaDocument(
  title: string,
  identity: PlayerDocumentIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<WikipediaFetchResult> {
  const crawledAt = new Date().toISOString();
  const query = new URLSearchParams({
    action: "query",
    prop: "extracts|revisions|categories",
    rvprop: "ids|timestamp",
    cllimit: "50",
    explaintext: "1",
    redirects: "1",
    format: "json",
    formatversion: "2",
    titles: title,
  });
  let response: Response;
  try {
    response = await fetchImpl(`${WIKIPEDIA_API_URL}?${query.toString()}`, {
      headers: { "User-Agent": RAG_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(RAG_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: "blocked", reason: "fetch_failed" };
  }
  if (!response.ok) {
    return { ok: false, status: "blocked", reason: `api_http_${response.status}` };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: "blocked", reason: "malformed_api_response" };
  }
  const pages = (payload as { query?: { pages?: WikipediaApiPage[] } }).query?.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    return { ok: false, status: "missing", reason: "no_page_in_response" };
  }
  const page = pages[0];
  if (page.missing || typeof page.pageid !== "number" || !page.title) {
    return { ok: false, status: "missing", reason: "document_absent" };
  }
  const extract = (page.extract ?? "").trim();
  if (!extract) return { ok: false, status: "missing", reason: "empty_extract" };
  const categories = (page.categories ?? []).map((entry) => entry.title ?? "").filter(Boolean);
  if (isWikipediaDisambiguation(extract, categories)) {
    return { ok: false, status: "rejected", reason: "disambiguation_document" };
  }
  // 나무위키와 동일한 identity 게이트 — 동명이인/비선수 문서는 여기서 거부된다.
  const identityVerdict = verifyPlayerDocumentIdentity(categories, page.title, identity);
  if (!identityVerdict.ok) {
    return { ok: false, status: "rejected", reason: identityVerdict.reason };
  }
  const revisionId = page.revisions?.[0]?.revid;
  if (typeof revisionId !== "number") {
    // revision이 없으면 provenance를 채울 수 없다 — 추정 revision으로 저장하지 않는다(fail-close).
    return { ok: false, status: "rejected", reason: "revision_absent" };
  }
  return {
    ok: true,
    requestedTitle: title,
    title: page.title,
    pageId: page.pageid,
    revisionId,
    canonicalUrl: wikipediaCanonicalUrl(page.title),
    categories,
    extract,
    crawledAt,
  };
}

/**
 * 두 tier2 소스 충돌 계약 — **전역 우선순위는 없다. 질문 의도별 가중만 있다.**
 *
 * 경위(2026-08-05): 하린아빠 지적("문보물을 아예 언급 안 한다")으로 처음엔 전역 나무위키 우선으로
 * 바꿨으나, 그 hard sort 는 삼순 P0 로 **폐기**됐다. 이유는 아래 `orderTier2Evidence` 주석 참조.
 *
 * 현재 계약:
 * - 소스 순서를 강제하지 않는다. `tier2WeightForQuestion` 이 **질문 의도별로 유사도에 가중치를
 *   곱할 뿐**이다(`TIER2_INTENT_BOOST`). 팬덤 축(별명·여담·응원가)은 나무위키, 프로필 축
 *   (소속·포지션·데뷔)는 위키피디아 가중. 그 외는 가중 없음.
 * - 가중은 **탈락이 아니다**. 반대편 근거가 충분히 더 가까우면 그쪽이 1위로 올라온다.
 *
 * 안 바뀌는 것:
 * - 두 소스 모두 tier2이므로 **어느 쪽도 수치를 확정하지 못한다**(§12 수치 계약 그대로).
 *   기록/숫자의 정본은 여전히 우리 DB(`kbo_structured`)이며 이 가중과 무관하다.
 * - 어느 쪽이 근거였는지는 provenance(canonicalUrl)로 항상 구분된다 — 출처 표기가 소스별로 다르다.
 */
export const TIER2_SOURCES = ["namu", "wikipedia"] as const;
export type Tier2Source = (typeof TIER2_SOURCES)[number];

export function tier2SourceOf(canonicalUrl: string): Tier2Source | null {
  if (canonicalUrl.startsWith(`https://${WIKIPEDIA_HOST}/`)) return "wikipedia";
  if (canonicalUrl.startsWith("https://namu.wiki/")) return "namu";
  return null;
}

/**
 * ⚠️ 전역 hard sort(`orderTier2Evidence`)는 폐기했다 (삼순 P0, 2026-08-05).
 *
 * 모든 tier2 근거를 나무위키 우선으로 재정렬하면
 * (a) 프로필·소속·데뷔 같은 **공식 사실**까지 편집검증된 위키피디아가 밀리고
 * (b) 순서 강제가 유사도를 무시해, 훨씬 가까운 위키피디아 근거가 무관한 나무위키 4건에 전부 탈락된다.
 * 대신 **의도별 점수 가중**을 쓴다 — 아래 `tier2WeightForQuestion`.
 */

/** 질문이 어느 쪽 서술을 원하는가. */
export type Tier2Intent = "fandom" | "profile" | "neutral";

/** 팬덤·커뮤니티 서술 — 나무위키가 사실상 정본인 축(위키피디아엔 거의 없다). */
const FANDOM_INTENT_WORDS = [
  "별명", "별칭", "애칭", "닉네임", "불리",
  "밈", "여담", "일화", "응원가", "등장곡", "팬덤",
];
/** 공식 프로필 — 편집 검증 절차가 있는 위키피디아가 앞서야 하는 축. */
const PROFILE_INTENT_WORDS = [
  "소속", "어느 팀", "어느팀", "무슨 팀", "무슨팀",
  "포지션", "수비 위치", "투수", "좌타", "우타",
  "출신", "학교", "고등학교", "중학교", "데뷔", "입단", "생년", "프로필",
];

/**
 * 질문 의도 분류. 둘 다 걸리면 팬덤을 우선한다 — "문보경 소속과 별명" 같은 복합 질문은
 * 나무위키가 둘 다 담지만 위키피디아는 별명을 안 담기 때문이다.
 */
export function classifyTier2Intent(question: string): Tier2Intent {
  const normalized = question.normalize("NFKC").toLowerCase();
  if (FANDOM_INTENT_WORDS.some((word) => normalized.includes(word))) return "fandom";
  if (PROFILE_INTENT_WORDS.some((word) => normalized.includes(word))) return "profile";
  return "neutral";
}

/**
 * 의도에 맞춰 유사도에 곱할 가중치. 1.0 이면 개입 없음.
 *
 * 1.15 는 "비슷한 점수면 이쪽을 앞에 둔다" 정도다. 상대편이 분명히 더 가까우면
 * 가중치로도 뒤집지 못하므로 **무관한 근거가 boost 만으로 앞에 오지 않는다**.
 * hard sort 와 달리 반대편 소스를 **탈락시키지 않는다**.
 */
export const TIER2_INTENT_BOOST = 1.15;

export function tier2WeightFor(intent: Tier2Intent): (canonicalUrl: string) => number {
  return (canonicalUrl) => {
    const source = tier2SourceOf(canonicalUrl);
    if (source === null) return 1;
    if (intent === "fandom") return source === "namu" ? TIER2_INTENT_BOOST : 1;
    if (intent === "profile") return source === "wikipedia" ? TIER2_INTENT_BOOST : 1;
    return 1;
  };
}

/** 질문으로 바로 가중치 함수를 얻는 진입점 — 서버가 쓰는 유일한 진입점이다. */
export function tier2WeightForQuestion(question: string): (canonicalUrl: string) => number {
  return tier2WeightFor(classifyTier2Intent(question));
}
