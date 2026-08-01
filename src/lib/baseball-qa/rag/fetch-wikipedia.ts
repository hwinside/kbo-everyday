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
 * 두 tier2 소스 충돌 계약 (하린아빠 지시: "위키피디아를 기본으로 하되" 나무위키는 보조).
 *
 * - 두 소스 모두 tier2이므로 **어느 쪽도 수치를 확정하지 못한다**(§12 수치 계약은 그대로).
 * - 서술이 충돌하면 **위키피디아를 우선**한다(편집 검증 절차가 있는 기본 소스).
 * - 나무위키는 위키피디아에 **없는 정보**(별명·팬덤 서술)를 보충할 때만 근거가 된다.
 * - 어느 쪽이 근거였는지는 provenance(canonicalUrl)로 항상 구분된다 — 출처 표기가 소스별로 다르다.
 */
export const TIER2_SOURCE_PRIORITY = ["wikipedia", "namu"] as const;
export type Tier2Source = (typeof TIER2_SOURCE_PRIORITY)[number];

export function tier2SourceOf(canonicalUrl: string): Tier2Source | null {
  if (canonicalUrl.startsWith(`https://${WIKIPEDIA_HOST}/`)) return "wikipedia";
  if (canonicalUrl.startsWith("https://namu.wiki/")) return "namu";
  return null;
}

/**
 * 같은 entity에 대한 tier2 근거 정렬 — 위키피디아가 앞선다.
 * 충돌 시 프롬프트에서 먼저 읽히는 쪽이 기본 서술이 되고, 나무위키는 보충으로 뒤에 붙는다.
 * 정렬은 **안정 정렬**이라 같은 소스 안에서는 유사도 순서가 보존된다.
 */
export function orderTier2Evidence<T extends { canonicalUrl: string }>(rows: T[]): T[] {
  const rank = (row: T): number => {
    const source = tier2SourceOf(row.canonicalUrl);
    return source === null ? TIER2_SOURCE_PRIORITY.length : TIER2_SOURCE_PRIORITY.indexOf(source);
  };
  return rows
    .map((row, index) => ({ row, index, rank: rank(row) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ row }) => row);
}
