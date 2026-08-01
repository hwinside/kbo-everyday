/**
 * canonical 확정 게이트 (spec rev0.7 §12.2 d).
 *
 * 계약: **HTTP 200 단독으로 canonical을 단정하지 않는다.** 다음 셋을 모두 대조해 통과한 문서만
 * `resolved`가 될 수 있다.
 *   (1) redirect 최종 URL 정규화 — 요청 후보 URL이 아니라 실제로 도달한 문서 URL을 기준으로 한다.
 *   (2) `rel=canonical` 링크 — 문서가 스스로 선언한 canonical과 최종 URL이 같은 문서를 가리켜야 한다.
 *   (3) page title ↔ entity identity — 문서 제목이 이 entity의 허용 제목 집합과 일치해야 한다.
 *
 * 왜 필요한가: status만 보면 redirect나 soft-200(다른 문서를 200으로 돌려주는 경우)에서 **다른 문서의
 * 내용이 이 선수 것으로 귀속**된다. chunk는 DB의 entity_id로 쓰이므로 entity filter는 이 오염을
 * 막지 못한다. 그래서 수집(resolve) 시점과 적재(ingest) 시점 **양쪽**에서 같은 함수로 대조한다.
 *
 * 이 모듈은 순수 함수만 담는다(네트워크 없음) — 회귀가 배포되는 계약 그대로를 검증할 수 있게.
 */

/** 문서 URL로 허용하는 호스트. 다른 호스트로의 redirect는 동일 문서로 인정하지 않는다. */
export const NAMU_DOCUMENT_HOST = "namu.wiki";
/** 나무위키 문서 경로 접두. robots.txt가 명시 허용한 경로다(§12.2 a). */
const NAMU_DOCUMENT_PATH_PREFIX = "/w/";
/** 제목 뒤에 붙는 사이트 표기 — identity 대조 전에 제거한다. */
const TITLE_SITE_SUFFIX = /\s*[-|–—]\s*나무위키\s*$/;
/** 동음이의/목록 페이지는 단일 entity 문서가 아니다. */
const NON_ENTITY_TITLE_MARKERS = ["(동음이의)", "(동명이인)", "(목록)"];

export interface CanonicalIdentityInput {
  /** 요청한 후보 URL. */
  requestedUrl: string;
  /** redirect를 따라간 뒤의 최종 URL (`Response.url`). */
  finalUrl: string;
  /** 응답 본문 HTML. */
  html: string;
  /** 이 entity가 가질 수 있는 문서 제목 폐쇄집합. */
  expectedTitles: string[];
}

export type CanonicalVerdict =
  | { ok: true; canonicalUrl: string; pageTitle: string; redirected: boolean }
  | { ok: false; reason: string };

/**
 * 문서 URL 정규화 — 두 URL이 같은 문서를 가리키는지 비교할 수 있는 형태로 만든다.
 * percent-encoding·fragment·trailing slash·쿼리 차이는 같은 문서다. 호스트/경로 접두가 계약 밖이면 null.
 */
export function normalizeDocumentUrl(value: string, base?: string): string | null {
  let parsed: URL;
  try {
    parsed = base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname.toLowerCase() !== NAMU_DOCUMENT_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith(NAMU_DOCUMENT_PATH_PREFIX)) return null;
  const title = pathname.slice(NAMU_DOCUMENT_PATH_PREFIX.length).replace(/\/+$/, "");
  if (!title) return null;
  return `https://${NAMU_DOCUMENT_HOST}${NAMU_DOCUMENT_PATH_PREFIX}${normalizeTitle(title)}`;
}

/** 제목 정규화 — 공백/유니코드 형태 차이는 같은 제목으로 본다. */
export function normalizeTitle(value: string): string {
  return value.normalize("NFC").replace(/[_\s]+/g, " ").trim();
}

/** `<link rel="canonical" href="...">` 추출 (속성 순서 무관). */
export function extractCanonicalLink(html: string): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["']?canonical["']?/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (href) return decodeHtmlEntities(href[1].trim());
  }
  return null;
}

/** 문서 제목 추출 — og:title 우선, 없으면 `<title>`. 사이트 표기는 제거한다. */
export function extractPageTitle(html: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\bproperty\s*=\s*["']?og:title["']?/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (content?.[1]?.trim()) return cleanTitle(content[1]);
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title?.[1]?.trim()) return cleanTitle(title[1]);
  return null;
}

function cleanTitle(raw: string): string {
  return normalizeTitle(decodeHtmlEntities(raw).replace(TITLE_SITE_SUFFIX, ""));
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** 선수 문서 제목 폐쇄집합 — inventory가 만든 후보 제목과 동일한 규칙이다. */
export function expectedPlayerTitles(name: string): string[] {
  return [`${name}(야구선수)`, name, `${name}(야구)`];
}

/**
 * §12.2(d) canonical 확정 판정.
 * 하나라도 어긋나면 `resolved`가 아니다 — 확인되지 않은 것을 확인된 것으로 취급하지 않는다.
 */
export function verifyCanonicalIdentity(input: CanonicalIdentityInput): CanonicalVerdict {
  const requested = normalizeDocumentUrl(input.requestedUrl);
  if (!requested) return { ok: false, reason: "requested_url_out_of_contract" };

  // (1) redirect 최종 URL — 요청 URL이 아니라 실제 도달 문서가 기준이다.
  const final = normalizeDocumentUrl(input.finalUrl);
  if (!final) return { ok: false, reason: "final_url_out_of_contract" };

  // (2) rel=canonical — 문서가 스스로 선언한 canonical이 없으면 확정하지 않는다.
  const canonicalLink = extractCanonicalLink(input.html);
  if (!canonicalLink) return { ok: false, reason: "canonical_link_absent" };
  const canonical = normalizeDocumentUrl(canonicalLink, input.finalUrl);
  if (!canonical) return { ok: false, reason: "canonical_link_out_of_contract" };
  if (canonical !== final) return { ok: false, reason: "canonical_link_mismatch_final_url" };

  // (3) page title ↔ entity identity.
  const pageTitle = extractPageTitle(input.html);
  if (!pageTitle) return { ok: false, reason: "page_title_absent" };
  if (NON_ENTITY_TITLE_MARKERS.some((marker) => pageTitle.includes(marker))) {
    return { ok: false, reason: "non_entity_page_title" };
  }
  const allowed = new Set(input.expectedTitles.map(normalizeTitle));
  if (!allowed.has(pageTitle)) return { ok: false, reason: "page_title_entity_mismatch" };

  // canonical URL의 문서명도 같은 identity여야 한다 (title만 맞고 URL이 다른 문서인 경우 차단).
  const canonicalTitle = normalizeTitle(
    canonical.slice(`https://${NAMU_DOCUMENT_HOST}${NAMU_DOCUMENT_PATH_PREFIX}`.length),
  );
  if (!allowed.has(canonicalTitle)) return { ok: false, reason: "canonical_url_entity_mismatch" };

  return { ok: true, canonicalUrl: canonical, pageTitle, redirected: requested !== final };
}
