/**
 * canonical 확정 게이트 (spec rev0.7 §12.2 d).
 *
 * 계약: **HTTP 200 단독으로 canonical을 단정하지 않는다.** 다음을 모두 대조해 통과한 문서만
 * `resolved`가 될 수 있다.
 *   (1) redirect 최종 URL 정규화 — 요청 후보 URL이 아니라 실제로 도달한 문서 URL을 기준으로 한다.
 *   (2) `rel=canonical` 링크 — 문서가 스스로 선언한 canonical과 최종 URL이 같은 문서를 가리켜야 한다.
 *   (3) 문서 identity — 문서가 **이 선수 본인의 문서**임을 문서 자신의 메타(분류)로 확인한다.
 *
 * ⚠️ 2026-08-01 실크롤 실측으로 (3)의 구현이 교체되었다 (R3).
 * R2까지 (3)은 "제목이 `{이름}` / `{이름}(야구선수)` / `{이름}(야구)` 폐쇄집합에 속하는가"였다.
 * 실제 나무위키 마크업 16건을 크롤해 이 게이트를 그대로 걸어본 결과 **16/16이 통과했지만
 * 그중 5건이 선수 본인 문서가 아니었다** — fail-open이다:
 *   - `강백호` → 동음이의 문서(슬램덩크·래퍼 등). 선수는 `강백호(야구선수)`.
 *   - `김현준` → 동명이인 문서. 선수는 `김현준(2002년 10월)`.
 *   - `박재현` → 동명이인 문서. 선수는 `박재현(2006)`.
 *   - `이원석` → 동명이인 문서. 선수는 `이원석(1999)`.
 *   - `네일`   → 영어 단어 문서. 선수는 `제임스 네일`.
 * 제목 폐쇄집합이 무력한 이유는 실제 문서명이 `(야구선수)`가 아니라 `(2002년 10월)`·`(1999)`처럼
 * **예측 불가능한 구분자**를 쓰거나 등록명 자체가 다르기 때문이다(네일 → 제임스 네일).
 *
 * 그래서 identity 근거를 **문서가 스스로 선언한 분류(category)**로 바꾼다:
 *   (3a) 동음이의/동명이인 분류가 있으면 단일 entity 문서가 아니다 → 거부.
 *   (3b) "야구 선수" 분류가 없으면 이 선수의 문서가 아니다 → 거부.
 *   (3c) 로스터 생년과 `{생년}년 출생` 분류가 일치해야 한다 → 동명이인 오귀속의 결정적 차단.
 *   (3d) 문서 제목이 선수 이름을 포함해야 한다(등록명 표기 차이 허용, 완전 무관 문서 차단).
 * (1)(2)와 "HTTP 200 단독 canonical 금지"는 그대로 유지된다.
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
/** 동음이의/목록 페이지는 단일 entity 문서가 아니다(제목 표기 기준). */
const NON_ENTITY_TITLE_MARKERS = ["(동음이의)", "(동명이인)", "(목록)"];
/** 나무위키 분류 경로 접두 — 문서가 스스로 선언한 분류 링크는 `/w/분류:...` 형태다. */
const CATEGORY_PATH_PREFIX = "/w/분류:";
/** 이 분류가 붙은 문서는 단일 entity 문서가 아니다 (실측: 강백호·김현준·박재현·이원석). */
const DISAMBIGUATION_CATEGORIES = ["동음이의어", "동명이인", "동음이의"];
/**
 * 야구 선수 문서임을 선언하는 분류.
 * 실측 표기: `대한민국의 야구 선수`, `대한민국의 남자 야구 선수`, `미국의 야구 선수`(외국인 선수).
 * 접미 일치("야구 선수"로 끝남)로 국적 표기 변형을 흡수한다.
 */
const BASEBALL_PLAYER_CATEGORY_SUFFIX = "야구 선수";

export interface CanonicalIdentityInput {
  /** 요청한 후보 URL. */
  requestedUrl: string;
  /** redirect를 따라간 뒤의 최종 URL (`Response.url`). */
  finalUrl: string;
  /** 응답 본문 HTML. */
  html: string;
  /**
   * 선수 identity 대조 근거 (R3, 실 마크업 기준).
   * 이름과 생년(YYYY)을 함께 요구한다 — 동명이인 문서를 이름만으로 걸러낼 수 없기 때문이다.
   * 미제공이면 문서 분류 대조를 수행할 수 없으므로 `identity_evidence_absent`로 거부한다(fail-close).
   */
  playerIdentity?: PlayerDocumentIdentity;
}

export type CanonicalVerdict =
  | {
      ok: true;
      canonicalUrl: string;
      pageTitle: string;
      redirected: boolean;
      /** 판정 근거로 쓴 문서 분류 — provenance에 남긴다. */
      identityCategories: string[];
    }
  | { ok: false; reason: string };

export interface CanonicalSubdocumentInput {
  requestedUrl: string;
  finalUrl: string;
  html: string;
  /** canonical이 반드시 `${entityRootTitle}/…`로 시작해야 한다. */
  entityRootTitle: string;
}

export type CanonicalSubdocumentVerdict =
  | { ok: true; canonicalUrl: string; pageTitle: string; sectionPath: string; redirected: boolean }
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

/** 정규화된 나무위키 URL에서 decoded 문서 제목(계층 경로)을 꺼낸다. */
export function documentTitleFromUrl(value: string): string | null {
  const normalized = normalizeDocumentUrl(value);
  if (!normalized) return null;
  return normalizeTitle(normalized.slice(`https://${NAMU_DOCUMENT_HOST}${NAMU_DOCUMENT_PATH_PREFIX}`.length));
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

/**
 * 문서가 스스로 선언한 분류 목록을 추출한다.
 * 나무위키는 분류를 `<a href="/w/%EB%B6%84%EB%A5%98:...">` 링크로 렌더링한다(실측).
 * 링크 텍스트가 아니라 **href의 문서명**을 쓴다 — 표시 텍스트는 스타일/약칭으로 흔들릴 수 있다.
 */
export function extractDocumentCategories(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    let href: string;
    try {
      href = decodeURIComponent(decodeHtmlEntities(match[1]));
    } catch {
      continue;
    }
    if (!href.startsWith(CATEGORY_PATH_PREFIX)) continue;
    const name = normalizeTitle(href.slice(CATEGORY_PATH_PREFIX.length).split(/[?#]/)[0]);
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * 선수 문서 **후보** 제목 — 이건 identity 근거가 아니라 "어디를 먼저 열어볼까"의 순서일 뿐이다.
 * 실제 identity는 `verifyPlayerDocumentIdentity`(문서 분류 대조)가 판정한다.
 */
export function expectedPlayerTitles(name: string): string[] {
  return [`${name}(야구선수)`, name, `${name}(야구)`];
}

/** 동음이의 문서에서 파생 후보 제목을 뽑을 때 훑는 링크 수 상한 (bounded). */
export const DISAMBIGUATION_CANDIDATE_LIMIT = 6;

/**
 * 동음이의/동명이인 문서에서 **같은 이름의 실제 문서 후보**를 뽑는다.
 *
 * 실측상 선수 문서명은 `(야구선수)`가 아니라 `(2002년 10월)`·`(1999)`처럼 예측 불가능하다.
 * 그래서 후보 제목을 규칙으로 만들어내는 대신, 동음이의 문서가 직접 링크한 문서 중
 * 이름을 포함한 것을 후보로 삼는다(예: `강백호` → `강백호(야구선수)`, `네일` → `제임스 네일`).
 * 후보가 맞는지는 여기서 판단하지 않는다 — 각 후보를 열어 분류로 확인한다.
 */
export function extractDisambiguationCandidates(html: string, name: string): string[] {
  const target = normalizeTitle(name);
  const found: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    let href: string;
    try {
      href = decodeURIComponent(decodeHtmlEntities(match[1]));
    } catch {
      continue;
    }
    if (!href.startsWith(NAMU_DOCUMENT_PATH_PREFIX)) continue;
    const title = normalizeTitle(href.slice(NAMU_DOCUMENT_PATH_PREFIX.length).split(/[?#]/)[0]);
    if (!title || title === target) continue;
    if (title.startsWith("분류:") || title.startsWith("파일:") || title.startsWith("틀:")) continue;
    if (!title.includes(target)) continue;
    if (found.includes(title)) continue;
    found.push(title);
    if (found.length >= DISAMBIGUATION_CANDIDATE_LIMIT) break;
  }
  return found;
}

export interface PlayerDocumentIdentity {
  name: string;
  /** 로스터 생년 4자리. 동명이인 판별의 결정적 축이다. */
  birthYear: string;
}

/**
 * "이 문서가 이 선수 본인의 문서인가"를 **문서가 스스로 선언한 분류**로 판정한다.
 *
 * 나무위키(HTML 분류 링크)와 위키피디아(API `prop=categories`)가 **같은 규칙**을 쓴다 —
 * 소스마다 기준이 갈리면 한쪽에서 동명이인 문서가 통과한다. 실제로 R2까지 쓰던 제목 폐쇄집합은
 * 실 마크업에서 5/16을 잘못 통과시켰다(강백호·김현준·박재현·이원석·네일).
 */
export function verifyPlayerDocumentIdentity(
  rawCategories: string[],
  pageTitle: string,
  identity: PlayerDocumentIdentity,
): { ok: true } | { ok: false; reason: string } {
  // 위키피디아 API는 `분류:` 접두를 붙여 돌려준다. 접두를 벗겨 같은 어휘로 비교한다.
  const categories = rawCategories.map((category) =>
    normalizeTitle(category.replace(/^분류:/, "")),
  );
  if (categories.length === 0) return { ok: false, reason: "document_categories_absent" };

  // (3a) 동음이의/동명이인 문서는 단일 entity 문서가 아니다.
  if (categories.some((category) => DISAMBIGUATION_CATEGORIES.some((marker) => category.includes(marker)))) {
    return { ok: false, reason: "disambiguation_document" };
  }
  // (3b) 야구 선수 분류가 없으면 이 선수의 문서가 아니다(예: `네일` = 영어 단어 문서).
  if (!categories.some((category) => category.endsWith(BASEBALL_PLAYER_CATEGORY_SUFFIX))) {
    return { ok: false, reason: "not_baseball_player_document" };
  }
  // (3c) 생년 대조 — 동명이인 오귀속의 결정적 차단선이다.
  if (!categories.includes(`${identity.birthYear}년 출생`)) {
    return { ok: false, reason: "birth_year_mismatch" };
  }
  // (3d) 제목이 선수 이름을 포함해야 한다. 등록명 표기 차이(`네일`→`제임스 네일`)는 허용하되,
  //      이름과 완전히 무관한 문서는 여기서 걸린다.
  if (!pageTitle.includes(normalizeTitle(identity.name))) {
    return { ok: false, reason: "page_title_name_mismatch" };
  }
  return { ok: true };
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

  // (3) 문서 identity — 문서가 스스로 선언한 메타로 "이 선수 본인의 문서"임을 확인한다.
  const pageTitle = extractPageTitle(input.html);
  if (!pageTitle) return { ok: false, reason: "page_title_absent" };
  if (NON_ENTITY_TITLE_MARKERS.some((marker) => pageTitle.includes(marker))) {
    return { ok: false, reason: "non_entity_page_title" };
  }

  // identity 근거가 없으면 확정하지 않는다 — 제목 폐쇄집합만으로는 동명이인을 못 거른다(R3 실측).
  const identity = input.playerIdentity;
  if (!identity?.name || !/^\d{4}$/.test(identity.birthYear ?? "")) {
    return { ok: false, reason: "identity_evidence_absent" };
  }

  const categories = extractDocumentCategories(input.html);
  const identityVerdict = verifyPlayerDocumentIdentity(categories, pageTitle, identity);
  if (!identityVerdict.ok) return identityVerdict;

  return { ok: true, canonicalUrl: canonical, pageTitle, redirected: requested !== final, identityCategories: categories };
}

/**
 * 하위문서 canonical + entity 귀속 게이트.
 *
 * 메인 문서는 분류+생년으로 entity를 확정한다. 그 메인에서 발견한 하위문서는 분류가 없을 수 있어
 * 동일 규칙을 그대로 적용할 수 없다. 대신 HTTP 200 단독 금지(최종 URL + rel=canonical + title)는
 * 유지하고, decoded canonical 제목이 **확정된 메인 제목의 `${prefix}/…`**인지 추가 확인한다.
 * 다른 선수·일반 문서로의 링크는 이 함수에서 fail-close된다.
 */
export function verifyCanonicalSubdocumentIdentity(
  input: CanonicalSubdocumentInput,
): CanonicalSubdocumentVerdict {
  const requested = normalizeDocumentUrl(input.requestedUrl);
  if (!requested) return { ok: false, reason: "requested_url_out_of_contract" };
  const final = normalizeDocumentUrl(input.finalUrl);
  if (!final) return { ok: false, reason: "final_url_out_of_contract" };

  const canonicalLink = extractCanonicalLink(input.html);
  if (!canonicalLink) return { ok: false, reason: "canonical_link_absent" };
  const canonical = normalizeDocumentUrl(canonicalLink, input.finalUrl);
  if (!canonical) return { ok: false, reason: "canonical_link_out_of_contract" };
  if (canonical !== final) return { ok: false, reason: "canonical_link_mismatch_final_url" };

  const root = normalizeTitle(input.entityRootTitle);
  const sectionPath = documentTitleFromUrl(canonical);
  if (!sectionPath || !sectionPath.startsWith(`${root}/`)) {
    return { ok: false, reason: "subdocument_entity_prefix_mismatch" };
  }

  const pageTitle = extractPageTitle(input.html);
  if (!pageTitle) return { ok: false, reason: "page_title_absent" };
  if (normalizeTitle(pageTitle) !== sectionPath) {
    return { ok: false, reason: "page_title_canonical_mismatch" };
  }
  return {
    ok: true,
    canonicalUrl: canonical,
    pageTitle,
    sectionPath,
    redirected: requested !== final,
  };
}
