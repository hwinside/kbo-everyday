/**
 * 콘텐츠 조회수(숏츠·뉴스) 순수 정책 — 테스트 가능 · React/DOM 무관. 2026-08-14.
 *
 * dedup 규칙:
 *  - 숏츠: 뷰어에서 영상이 화면에 노출될 때 +1, 동일 세션당 영상 1회
 *    (스와이프 왕복 폭주 방지 — 게시글 impression과 동일 축)
 *  - 뉴스: 원문 열기(click)마다 +1 (게시글 click과 동일 축, dedup 없음)
 */

export type ContentViewType = "shorts" | "news";

export const CONTENT_VIEW_TYPES: readonly ContentViewType[] = ["shorts", "news"];

/** content_id 최대 길이 — DB CHECK와 동일하게 유지한다. */
export const CONTENT_ID_MAX_LENGTH = 512;

export function isContentViewType(value: unknown): value is ContentViewType {
  return value === "shorts" || value === "news";
}

/** content_id 유효성 — 비어있지 않고 DB CHECK 길이 이내. */
export function isValidContentId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= CONTENT_ID_MAX_LENGTH;
}

/** counts 응답/조회 키 — `${type}:${id}`. */
export function contentViewKey(type: ContentViewType, id: string): string {
  return `${type}:${id}`;
}

/**
 * 뉴스 기사 content_id — 언론사 원문(canonicalUrl) 우선, 없으면 클릭 타깃 URL.
 * 크롤 회차마다 바뀔 수 있는 내부 숫자 id 대신 URL을 안정 키로 쓴다
 * (뉴스 댓글 discussion 키와 동일 접근). 512자 초과분은 절단해 DB CHECK와 정합.
 */
export function newsContentId(url: string, canonicalUrl?: string | null): string | null {
  const target = canonicalUrl || url;
  if (!target || target === "#") return null;
  return target.slice(0, CONTENT_ID_MAX_LENGTH);
}

/** 숏츠 세션 dedup: 이 세션에서 아직 이 영상을 집계 안 했으면 true(집계 대상). */
export function shouldCountShortsView(seen: Set<string>, videoId: string): boolean {
  if (!isValidContentId(videoId)) return false;
  return !seen.has(contentViewKey("shorts", videoId));
}
