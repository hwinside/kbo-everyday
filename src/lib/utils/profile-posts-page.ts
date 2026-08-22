/**
 * 프로필 작성글 목록 페이징 순수 계약 — (created_at, id) 커서.
 *
 * 2026-08-22 이전 구현은 `.limit(20)` 하나뿐이라 21번째 글부터 **어떤 경로로도 도달할 수 없었다**
 * (하린아빠 #cs 제보). 1차 수정은 offset `range` 였는데 삼순 NO-GO 로 커서로 바꿨다:
 *
 *   offset 페이저는 "몇 번째부터"를 세는데, 그 사이 목록이 움직이면 기준이 어긋난다.
 *   - 1페이지를 본 뒤 새 글이 하나 들어오면 → page1 의 첫 글이 page0 마지막 글과 겹친다.
 *     dedupe 하면 39건이 되고, 다음 페이지 번호를 `posts.length/20` 으로 유도하므로
 *     39/20 = 1 → **page 1 을 영원히 다시 요청**한다(더보기가 먹통).
 *   - 반대로 글이 하나 지워지면 경계에 있던 글이 **조용히 건너뛰어진다**.
 *
 * 커서는 "마지막으로 본 글 다음"을 가리키므로 목록이 움직여도 이어지는 지점이 흔들리지 않는다.
 * 키는 `(created_at, id)` 복합이다 — created_at 단독은 유니크가 아니라(같은 초에 쓴 글이 있다)
 * 커서로 쓰면 동률 글을 건너뛰거나 무한 반복한다.
 */

/** 한 페이지 크기 — UI·게이트가 같은 상수를 읽는다(문자열 복제 금지). */
export const PROFILE_POSTS_PAGE_SIZE = 20;

export interface ProfilePostsCursor {
  createdAt: string;
  id: number;
}

/** 커서를 만들 수 있는 최소 형태. 실제 행 타입에 종속되지 않게 구조만 요구한다. */
export interface ProfilePostsCursorSource {
  id: number;
  created_at: string;
}

/**
 * 방금 받은 페이지의 **마지막 행**에서 다음 커서를 만든다.
 * 정렬이 `created_at desc, id desc` 이므로 마지막 행이 곧 "가장 오래된 것"이고,
 * 다음 페이지는 그보다 더 오래된 글들이다.
 */
export function profilePostsCursorFrom(rows: ProfilePostsCursorSource[]): ProfilePostsCursor | null {
  const last = rows.at(-1);
  if (!last || typeof last.created_at !== "string" || !last.created_at) return null;
  return { createdAt: last.created_at, id: last.id };
}

/**
 * PostgREST `or` 필터 문자열 — 사전식(lexicographic) 비교를 두 절로 표현한다.
 *
 *   created_at < C            (더 오래된 날짜)
 *   OR (created_at = C AND id < I)   (같은 시각이면 id 로 가른다)
 *
 * 값을 큰따옴표로 감싸는 이유: timestamptz 문자열에는 `+09:00` 의 `+` 와 `:` 가 들어가고,
 * PostgREST 의 `or=(...)` 문법에서 콤마·괄호가 구분자라 quote 없이 넣으면 파싱이 깨진다.
 */
export function profilePostsCursorFilter(cursor: ProfilePostsCursor): string {
  const at = JSON.stringify(cursor.createdAt);
  return `created_at.lt.${at},and(created_at.eq.${at},id.lt.${cursor.id})`;
}

/**
 * 한 건 더 요청해서(`limit(PAGE_SIZE + 1)`) 초과분 존재로 다음 페이지 여부를 판정한다.
 * 별도 count 쿼리가 없고, 정확히 PAGE_SIZE 가 오면 hasMore=false 다.
 */
export const PROFILE_POSTS_FETCH_LIMIT = PROFILE_POSTS_PAGE_SIZE + 1;

export function splitProfilePostsPage<T>(rows: T[]): { rows: T[]; hasMore: boolean } {
  const hasMore = rows.length > PROFILE_POSTS_PAGE_SIZE;
  return { rows: hasMore ? rows.slice(0, PROFILE_POSTS_PAGE_SIZE) : rows, hasMore };
}

/**
 * 이어붙일 때 id 기준으로 중복을 제거한다.
 * 커서 페이징이라 정상 흐름에선 겹치지 않지만, 경계에서 같은 글이 두 번 오면
 * React key 가 충돌하므로 방어한다. **원래 순서는 유지**한다(정렬을 다시 하지 않는다).
 */
export function appendProfilePosts<T extends { id: number }>(prev: T[], next: T[]): T[] {
  const seen = new Set(prev.map(row => row.id));
  return [...prev, ...next.filter(row => !seen.has(row.id))];
}
