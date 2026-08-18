/**
 * 나무위키 **standalone 참조문서** 추출·결속 계약 (2026-08-19 맛자욱 P0).
 *
 * ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
 * `구자욱 별명이 왜 맛자욱이야?` 의 정답 근거(배우 채수빈의 "열애설을 맛보기한 느낌" 발언
 * 유래)는 나무위키 **`맛자욱` 단독 문서**에 있다. 그런데 수집기는
 * `normalizeNamuEntitySubdocumentUrl` 이 `구자욱/…` prefix 하위문서만 허용해서
 * standalone 참조문서는 **원리적으로 수집 불가**였다. entity 본문(여담)에는
 * "맛자욱 문서 참고" 한 줄만 남아, 서빙 근거가 구조적으로 비어 있었다.
 *
 * ── 닫힌 패턴 (fail-close) ──────────────────────────────────────────────────
 * 참조문서 후보는 **entity 본인 문서 안의 명시적 참조 표기**에서만 나온다:
 *
 *   `<a href="/w/맛자욱">맛자욱</a> 문서 참고`
 *
 * 즉 ① 앵커의 href 제목과 앵커 텍스트가 동일하고 ② 앵커 직후 근접 창에 `문서 참고`
 * 표기가 따라오는 경우만 후보다. 본문에 흔한 일반 내부링크(다른 선수·구단·사건 문서)는
 * ②가 없어서 후보가 되지 않는다 — 열린 본문에서 링크를 긁는 것이 아니라, 나무위키의
 * 관용적 참조 표기라는 **닫힌 구조**만 읽는다.
 *
 * ── 결속(identity) 계약 ─────────────────────────────────────────────────────
 * standalone 문서는 하위문서와 달리 `{root}/…` prefix 도, 선수 분류(생년·야구선수)도
 * 보장되지 않는다. 그래서 결속 근거를 **양방향**으로 요구한다:
 *   (A) 발견 방향: canonical 확정된 entity 본인 문서 **안의** 닫힌 참조 표기에서 발견됐다.
 *   (B) 내용 방향: 참조문서 본문이 entity 이름(등록명)을 실제로 언급한다.
 * (A)와 (B)가 모두 성립할 때만 이 문서를 entity 의 참조문서로 귀속한다. 하나라도 없으면
 * 저장하지 않는다(fail-close) — 잘못 귀속된 문서는 entity 필터가 못 걸러낸다.
 *
 * HTTP 200 단독 canonical 금지(최종 URL + rel=canonical + 제목 대조)는 메인/하위문서와
 * 동일하게 유지한다. 이 모듈은 순수 함수만 담는다(네트워크 없음) — 게이트가 배포 계약
 * 그대로를 검증할 수 있게.
 */

import {
  documentTitleFromUrl,
  extractCanonicalLink,
  extractPageTitle,
  normalizeDocumentUrl,
  normalizeTitle,
} from "./canonical";

/**
 * entity 당 참조문서 수집 상한.
 * 실측상 선수 문서의 `문서 참고` 표기는 0~2건이다. 상한 초과는 truncate 하지 않고
 * 수집기에서 entity 전체 fail-close 한다(하위문서 상한과 같은 계약).
 */
export const NAMU_MAX_REFERENCE_DOCS_PER_ENTITY = 4;

/**
 * 앵커 닫힘(`</a>`)과 `문서 참고` 표기 사이에 허용하는 창(문자).
 * 실측 마크업은 `</a> 문서 참고` · `</a> - 문서 참고` · `</a>의 문서 참고` 수준이다.
 * 창을 넓히면 무관한 뒷문장의 `문서 참고`가 앞 앵커에 오귀속되므로 좁게 고정한다.
 */
export const REFERENCE_HINT_WINDOW_CHARS = 24;

/** 닫힌 참조 표기. `문서 참고`·`문서를 참고` 두 관용형만 인정한다. */
const REFERENCE_HINT = /^[^<>]{0,24}?문서(?:를|도)?\s*참고/u;

/** 문서 네임스페이스 접두 — 일반 문서가 아니므로 참조문서 후보에서 제외한다. */
const NON_CONTENT_TITLE_PREFIXES = ["분류:", "파일:", "틀:", "사용자:", "토론:"];

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "").trim();
}

export interface NamuReferenceDocLink {
  /** 정규화된 참조문서 URL. */
  url: string;
  /** 앵커 텍스트(= href 제목과 동일해야 후보다). */
  title: string;
}

/**
 * entity 문서 HTML 에서 닫힌 참조 표기(`<a href="/w/X">X</a> … 문서 참고`)만 추출한다.
 *
 * 후보 조건 (전부 만족):
 *   ① href 가 나무위키 문서 계약 안(`normalizeDocumentUrl`)
 *   ② href 제목 == 앵커 텍스트 (표기 정규화 후 exact) — 표시문구가 다른 링크는 참조 표기가 아니다
 *   ③ 앵커 닫힘 직후 근접 창 안에 `문서 참고` 표기
 *   ④ standalone 문서 — entity root 자신도, `{root}/…` 하위문서도 아니다(그건 기존 경로가 수집한다)
 *   ⑤ 분류/파일/틀 네임스페이스가 아니다
 */
export function extractNamuReferenceDocLinks(
  html: string,
  baseUrl: string,
  entityRootTitle: string,
): NamuReferenceDocLink[] {
  const root = normalizeTitle(entityRootTitle);
  const found: NamuReferenceDocLink[] = [];
  for (const match of html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const normalized = normalizeDocumentUrl(decodeHtmlAttribute(match[1]), baseUrl);
    if (!normalized) continue;
    const title = documentTitleFromUrl(normalized);
    if (!title) continue;
    // ④ standalone 만 — root 자신/하위문서는 기존 수집 경로의 몫이다.
    if (title === root || title.startsWith(`${root}/`)) continue;
    // ⑤ 비콘텐츠 네임스페이스 제외.
    if (NON_CONTENT_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))) continue;
    // ② 앵커 텍스트 == href 제목.
    const anchorText = normalizeTitle(stripTags(match[2]));
    if (anchorText !== title) continue;
    // ③ 닫힘 직후 근접 창에 `문서 참고`.
    const tail = html.slice(
      (match.index ?? 0) + match[0].length,
      (match.index ?? 0) + match[0].length + REFERENCE_HINT_WINDOW_CHARS + 16,
    );
    if (!REFERENCE_HINT.test(stripLeadingTags(tail))) continue;
    if (!found.some((entry) => entry.url === normalized)) {
      found.push({ url: normalized, title });
    }
  }
  return found;
}

/** 근접 창 판정 전에 앞머리의 태그 조각만 벗긴다(창 밖 텍스트를 끌어오지 않는다). */
function stripLeadingTags(value: string): string {
  return value.replace(/^(?:\s*<[^>]*>)*/u, "");
}

export interface CanonicalReferenceDocumentInput {
  requestedUrl: string;
  finalUrl: string;
  html: string;
  /** canonical 확정된 entity 메인 문서 제목(예: `구자욱`). */
  entityRootTitle: string;
  /** 발견 시점의 앵커 제목 — canonical 제목과 exact 일치해야 한다. */
  anchorTitle: string;
  /** 결속 (B): 본문이 이 이름(등록명)을 언급해야 한다. */
  entityName: string;
}

export type CanonicalReferenceDocumentVerdict =
  | { ok: true; canonicalUrl: string; pageTitle: string; sectionPath: string; redirected: boolean }
  | { ok: false; reason: string };

/** 참조문서 chunk 의 sectionPath. 기록 섹션 판정(`선수 경력/YYYY년` 등)과 절대 겹치지 않는 형태다. */
export function referenceSectionPathFor(entityRootTitle: string, referenceTitle: string): string {
  return `${normalizeTitle(entityRootTitle)}/참고:${normalizeTitle(referenceTitle)}`;
}

/**
 * standalone 참조문서 canonical + 결속 게이트.
 *
 * HTTP 200 단독 금지(최종 URL + rel=canonical + 제목 대조)는 하위문서 게이트와 동일하고,
 * prefix 대조 대신 **anchor exact + 본문 entity 언급**(양방향 결속)을 요구한다.
 */
export function verifyCanonicalReferenceDocumentIdentity(
  input: CanonicalReferenceDocumentInput,
): CanonicalReferenceDocumentVerdict {
  const requested = normalizeDocumentUrl(input.requestedUrl);
  if (!requested) return { ok: false, reason: "requested_url_out_of_contract" };
  const final = normalizeDocumentUrl(input.finalUrl);
  if (!final) return { ok: false, reason: "final_url_out_of_contract" };

  const canonicalLink = extractCanonicalLink(input.html);
  if (!canonicalLink) return { ok: false, reason: "canonical_link_absent" };
  const canonical = normalizeDocumentUrl(canonicalLink, input.finalUrl);
  if (!canonical) return { ok: false, reason: "canonical_link_out_of_contract" };
  if (canonical !== final) return { ok: false, reason: "canonical_link_mismatch_final_url" };

  const canonicalTitle = documentTitleFromUrl(canonical);
  if (!canonicalTitle) return { ok: false, reason: "canonical_title_absent" };
  // 발견 시점 앵커 제목과 도달한 문서 제목이 다르면(redirect 로 다른 문서에 도달 등)
  // "entity 문서가 참조한 그 문서"라는 결속 (A)가 깨진다.
  if (canonicalTitle !== normalizeTitle(input.anchorTitle)) {
    return { ok: false, reason: "reference_anchor_canonical_mismatch" };
  }

  const pageTitle = extractPageTitle(input.html);
  if (!pageTitle) return { ok: false, reason: "page_title_absent" };
  if (normalizeTitle(pageTitle) !== canonicalTitle) {
    return { ok: false, reason: "page_title_canonical_mismatch" };
  }

  // 결속 (B): 참조문서 본문이 entity 이름을 실제로 언급해야 한다.
  // 이름이 본문에 한 번도 없는 문서는 이 선수에 귀속할 내용적 근거가 없다.
  const bodyText = stripTags(input.html.replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, " "));
  if (!bodyText.includes(normalizeTitle(input.entityName))) {
    return { ok: false, reason: "reference_body_entity_name_absent" };
  }

  return {
    ok: true,
    canonicalUrl: canonical,
    pageTitle,
    sectionPath: referenceSectionPathFor(input.entityRootTitle, canonicalTitle),
    redirected: requested !== final,
  };
}
