/**
 * Supabase 기본 max-rows(1000) 상한을 넘는 결과를 range 페이지네이션으로 전량 수집.
 *
 * `.limit()` 없이 큰 테이블을 조회하면 서버 max-rows에서 조용히 잘린다. 정렬이 걸려 있으면
 * "정렬 앞쪽 N행만" 반환되므로(예: game_date 오름차순 → 오래된 1000행), 최신 데이터가 유실된다.
 * fetchPage(from, to)는 Supabase `.range(from, to)`(양끝 포함)를 그대로 넘겨 호출한다.
 */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize = 1000,
): Promise<T[]> {
  if (pageSize < 1) throw new Error("pageSize must be >= 1");
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1);
    if (!page || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break; // 마지막 페이지(부분/정확히 채운 뒤 빈 페이지로 종료)
  }
  return all;
}

export type PageError = { message: string } | null;

export interface KeysetPage<T> {
  data: T[] | null;
  error: PageError;
}

type Keyset = string | number;

function compareKey(a: Keyset, b: Keyset): number {
  if (typeof a !== typeof b) throw new Error("keyset type changed between pages");
  return a === b ? 0 : a > b ? 1 : -1;
}

/**
 * 유일 키 오름차순 keyset 페이지네이션으로 전량 수집한다.
 *
 * fetchPage는 `key > cursor`, `order(key asc)`, `limit(pageSize)` 계약을 지켜야 한다.
 * 어느 페이지든 조회 오류/비유일·역행 키가 나오면 throw하여 partial rows 사용을 막는다.
 */
export async function fetchAllByKeyset<T, K extends Keyset>(
  fetchPage: (cursor: K | null, limit: number) => Promise<KeysetPage<T>>,
  keyOf: (row: T) => K,
  options: { pageSize?: number; label?: string } = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? 1000;
  const label = options.label ?? "keyset query";
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("pageSize must be a positive integer");
  }

  const all: T[] = [];
  let cursor: K | null = null;
  for (;;) {
    const { data, error } = await fetchPage(cursor, pageSize);
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = data ?? [];
    if (page.length > pageSize) throw new Error(`${label}: page exceeded requested limit`);
    if (page.length === 0) return all;

    let previous = cursor;
    for (const row of page) {
      const key = keyOf(row);
      if (previous !== null && compareKey(key, previous) <= 0) {
        throw new Error(`${label}: keyset must be unique and strictly ascending`);
      }
      previous = key;
    }

    all.push(...page);
    cursor = previous as K;
    if (page.length < pageSize) return all;
  }
}
