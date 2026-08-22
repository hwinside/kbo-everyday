/**
 * 프로필 작성글 목록 페이징 순수 계약.
 *
 * 2026-08-22 이전 구현은 `.limit(20)` 하나뿐이라 21번째 글부터 **어떤 경로로도 도달할 수 없었다**
 * (하린아빠 #cs 제보). 헤더 카운트는 `count: exact` 라서 "글 144" 라고 써놓고 목록엔 20개만
 * 나오는 상태였다. 페이징 산식을 순수 함수로 빼서 게이트가 네트워크 없이 결함을 잡게 한다.
 */

/** 한 페이지 크기 — UI·게이트가 같은 상수를 읽는다(문자열 복제 금지). */
export const PROFILE_POSTS_PAGE_SIZE = 20;

/**
 * PostgREST `range(from, to)` 는 **양끝 포함**이다. 그래서 한 페이지(20건)를 받으려면 to 는
 * `from + 19` 여야 하는데, 여기서는 일부러 **한 건 더**(`from + 20`) 요청한다.
 * 그 초과분 1건의 존재 여부가 곧 "다음 페이지가 있다" 이고, 별도 count 쿼리가 필요 없다.
 */
export function profilePostsRange(page: number): { from: number; to: number } {
  const from = page * PROFILE_POSTS_PAGE_SIZE;
  return { from, to: from + PROFILE_POSTS_PAGE_SIZE };
}

/**
 * 초과 1건을 잘라내고 hasMore 를 판정한다.
 * 정확히 PAGE_SIZE 개가 오면 hasMore=false 다 — 초과분이 없으므로 다음 페이지도 없다.
 */
export function splitProfilePostsPage<T>(rows: T[]): { rows: T[]; hasMore: boolean } {
  const hasMore = rows.length > PROFILE_POSTS_PAGE_SIZE;
  return { rows: hasMore ? rows.slice(0, PROFILE_POSTS_PAGE_SIZE) : rows, hasMore };
}

/**
 * 이미 받은 개수로 다음 페이지 번호를 유도한다. 별도 page 상태를 두면 더보기 중복 클릭에서
 * 같은 페이지를 두 번 요청하거나 한 페이지를 건너뛴다.
 */
export function nextProfilePostsPage(loadedCount: number): number {
  return Math.floor(loadedCount / PROFILE_POSTS_PAGE_SIZE);
}
