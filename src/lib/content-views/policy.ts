/**
 * 콘텐츠 조회수(숏츠·뉴스) 순수 정책 — 테스트 가능 · React/DOM 무관. 2026-08-14.
 *
 * dedup 규칙:
 *  - 숏츠: 풀스크린 뷰어에서 영상이 노출될 때마다 +1 — 단순 조회수, 클라 dedup 없음.
 *    썰네일/캐러셀 노출은 제외(풀스크린 뷰어만 집계).
 *    (2026-08-16 하린아빠 지시: 광고 인벤토리 가치 측정용 — IAB 기준 없이 그냥 단순하게
 *    조회수, 썰네일 노출 제외, dwell 게이팅 없음.)
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

/**
 * 숏츠 집계 대상 여부 — 단순 조회수(클라 dedup/창 없음, 순수).
 * 유효 id면 매 노출마다 집계(true), 무효 id만 제외.
 * (서버 route가 IP+콘텐츠 1초 abuse cap을 유지해 폭주만 막는다 — 이건 사기방지지 IAB 가시성 로직이 아니다.)
 */
export function shouldCountShortsView(videoId: string): boolean {
  return isValidContentId(videoId);
}
