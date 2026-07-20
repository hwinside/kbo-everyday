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
