/**
 * 콘텐츠 조회수(숏츠·뉴스) 순수 정책 — 테스트 가능 · React/DOM 무관. 2026-08-14.
 *
 * dedup 규칙:
 *  - 숏츠: 뷰어에서 영상이 화면에 노출될 때마다 +1(재조회 카운트).
 *    동일 영상은 짧은 창(SHORTS_RECOUNT_WINDOW_MS) 안의 중복만 차단 —
 *    내리면서 본 것·다시 본 것은 모두 집계하되, 순간 위아래 왕복 스팸만 막는다.
 *    (2026-08-16 하린아빠 지시: 뷰어에서 하나하나 본 영상 모두 카운트. dwell 게이팅 없음.)
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
 * 숏츠 재조회 중복 차단 창(ms). 이 시간 안의 같은 영상 재노출만 미집계 —
 * 순간 위아래 왕복 스와이프 스팸만 막고, 그 밖의 재조회는 다시 +1 된다.
 */
export const SHORTS_RECOUNT_WINDOW_MS = 30_000;

/**
 * 숏츠 집계 대상 여부(재조회 창 기반, 순수).
 * - 무효 id → 미집계.
 * - 이 영상을 이번 세션에서 처음 보거나(lastCountedMs 없음) 마지막 집계 이후
 *   windowMs 이상 지났으면 집계 대상(true). 창 안 재노출만 false.
 * community/view-rate-limit의 shouldAllowView와 동일한 시간창 판정 축.
 */
export function shouldCountShortsView(
  lastCountedMs: number | undefined,
  nowMs: number,
  videoId: string,
  windowMs: number = SHORTS_RECOUNT_WINDOW_MS,
): boolean {
  if (!isValidContentId(videoId)) return false;
  if (lastCountedMs === undefined) return true;
  return nowMs - lastCountedMs >= windowMs;
}
