/**
 * fetchAllRows range 페이지네이션 회귀 (team-card 주간 그래프 truncation fix).
 * 실행: npx tsx scripts/qa/paginate-smoke.ts
 */
import { fetchAllRows } from "../../src/lib/db/paginate";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// from/to(양끝 포함) 슬라이스를 반환하는 인메모리 페이저. .range() 시멘틱 미러.
function pager(total: number) {
  const rows = Array.from({ length: total }, (_, i) => i);
  const calls: Array<[number, number]> = [];
  const fetch = async (from: number, to: number) => {
    calls.push([from, to]);
    return rows.slice(from, to + 1);
  };
  return { fetch, calls };
}

(async () => {
  // (a) 1000행 초과 → 전량 수집(과거 버그: 1000에서 잘림)
  {
    const { fetch, calls } = pager(2500);
    const all = await fetchAllRows(fetch, 1000);
    ok("2500행 전량 수집(truncation 없음)", all.length === 2500 && all[0] === 0 && all[2499] === 2499);
    ok("2500행 → 3페이지 호출", calls.length === 3);
  }
  // (b) 정확히 배수(2000) → 빈 페이지로 종료(무한루프 아님)
  {
    const { fetch, calls } = pager(2000);
    const all = await fetchAllRows(fetch, 1000);
    ok("정확히 2배수 전량 수집", all.length === 2000);
    ok("2000행 → 3번째 호출이 빈 페이지로 종료", calls.length === 3);
  }
  // (c) 1페이지 미만
  {
    const { fetch, calls } = pager(37);
    const all = await fetchAllRows(fetch, 1000);
    ok("37행 → 1페이지", all.length === 37 && calls.length === 1);
  }
  // (d) 빈 결과
  {
    const { fetch } = pager(0);
    const all = await fetchAllRows(fetch, 1000);
    ok("빈 결과 → []", all.length === 0);
  }
  // (e) 잘못된 pageSize 방어
  {
    let threw = false;
    try {
      await fetchAllRows(async () => [], 0);
    } catch {
      threw = true;
    }
    ok("pageSize<1 → throw", threw);
  }

  console.log(`\npaginate smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
