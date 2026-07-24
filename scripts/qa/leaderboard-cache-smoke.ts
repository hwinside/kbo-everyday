/**
 * leaderboard-cache 회귀 스모크 (삼순 #801 NO-GO 반영).
 *
 * 핵심 계약: Supabase REST max-rows(1000) 상한 환경에서도 1,242행 전량 수집 —
 * 1,001위~ 유실·total 오류 재발 방지. 페이지 서버는 요청 limit과 무관하게
 * 최대 1000행만 반환하도록 시뮬레이션한다.
 */
import {
  queryAllLeaderboardRows,
  sortLeaderboardRows,
  type WritingLeaderboardRow,
} from "../../src/lib/events/leaderboard-cache";

const SERVER_MAX_ROWS = 1000;
const TOTAL_ROWS = 1242;

function makeRows(): WritingLeaderboardRow[] {
  const rows: WritingLeaderboardRow[] = [];
  for (let i = 0; i < TOTAL_ROWS; i += 1) {
    rows.push({
      user_id: `user-${String(i).padStart(5, "0")}`,
      nickname: `팬${i}`,
      team_id: i % 10,
      // 동점 구간(점수 7)이 tie-break 정렬 경로도 타도록 구성
      total_points: i < 30 ? 7 : (i * 13) % 500,
      last_active_day: `2026-05-${String((i % 28) + 1).padStart(2, "0")}`,
    });
  }
  return rows;
}

/** user_id keyset 계약(gt/order/limit)만 지원하는 최소 fake — REST 1000행 상한 재현 */
function fakeClient(rows: WritingLeaderboardRow[], pageSizes: number[]) {
  const byUserId = [...rows].sort((a, b) => (a.user_id < b.user_id ? -1 : 1));
  return {
    from(table: string) {
      if (table !== "v_leaderboard_writing") throw new Error(`unexpected table ${table}`);
      let cursor: string | null = null;
      let limitN = Infinity;
      const builder = {
        select: () => builder,
        order: (col: string) => {
          if (col !== "user_id") throw new Error(`non-deterministic order: ${col}`);
          return builder;
        },
        limit: (n: number) => {
          limitN = n;
          return builder;
        },
        gt: (col: string, v: string) => {
          if (col !== "user_id") throw new Error(`unexpected cursor col: ${col}`);
          cursor = v;
          return builder;
        },
        then: (resolve: (v: { data: WritingLeaderboardRow[]; error: null }) => unknown) => {
          const filtered = byUserId.filter((r) => cursor === null || r.user_id > cursor);
          const served = Math.min(limitN, SERVER_MAX_ROWS);
          pageSizes.push(Math.min(filtered.length, served));
          return Promise.resolve({ data: filtered.slice(0, served), error: null }).then(resolve);
        },
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

let pass = 0;
let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`✗ ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

async function main() {
  const source = makeRows();

  // ① 1000행 상한에서도 전량 수집 + 마지막 유저 보존
  const pageSizes: number[] = [];
  const rows = await queryAllLeaderboardRows(fakeClient(source, pageSizes));
  check("total preserved beyond max-rows", rows.length, TOTAL_ROWS);
  check("pages capped at server max-rows", pageSizes.every((n) => n <= SERVER_MAX_ROWS), true);
  check("multiple pages actually fetched", pageSizes.length >= 2, true);
  const ids = new Set(rows.map((r) => r.user_id));
  check("last user_id present", ids.has(`user-${String(TOTAL_ROWS - 1).padStart(5, "0")}`), true);
  check("no duplicates", ids.size, TOTAL_ROWS);

  // ② 정렬 계약: 점수 desc → last_active_day asc → user_id asc
  const resorted = sortLeaderboardRows(rows);
  check("rows already rank-sorted", rows.map((r) => r.user_id), resorted.map((r) => r.user_id));
  const violations = rows.filter((r, i) => {
    if (i === 0) return false;
    const p = rows[i - 1];
    if (p.total_points !== r.total_points) return p.total_points < r.total_points;
    if (p.last_active_day !== r.last_active_day) return p.last_active_day > r.last_active_day;
    return p.user_id > r.user_id;
  });
  check("sort order valid (desc pts, asc day, asc user_id)", violations.length, 0);

  console.log(`leaderboard-cache smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
