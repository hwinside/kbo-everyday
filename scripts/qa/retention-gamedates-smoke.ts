/**
 * 스모크: retention cron 경기일 수집·backfill 정책 — 2026-07-21 (PR #736 삼순 리뷰 반영).
 *   ① buildDateRange: 61일 범위·오름차순·월 경계
 *   ② resolveTargetDate: 기본 오늘 / 과거 소급 허용 / 형식·실존일·미래·60일 초과 거부
 *   ③ collectGameDates: 순서 보존·부분 실패 bounded retry·잔여 실패 fail-close 신호·재시도 상한
 *   ④ computeVisitDistribution: targetDate KST 일말 상한(미래 활동 오염 차단) — 삼순 재현 케이스
 *   ⑤ isBackfill: 과거 소급 시 funnel 제외 계약
 * 실행: npm run qa:retention-dates
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildDateRange,
  resolveTargetDate,
  collectGameDates,
  isBackfill,
  LOOKBACK_DAYS,
  MAX_RETRY_PASSES,
} from "../../src/lib/retention/gamedates";
import {
  computeActivationFunnel,
  computeVisitDistribution,
} from "../../src/lib/retention/compute";

/** 최소 fake supabase: created_at gte/lte 필터 + not-null + range 페이징 지원 */
type Row = Record<string, unknown>;
function fakeSupabase(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: ((r: Row) => boolean)[] = [];
      let orderColumn: string | null = null;
      let orderAscending = true;
      let pageLimit: number | null = null;
      const materialize = () => {
        const filtered = rows.filter((r) => filters.every((f) => f(r)));
        if (!orderColumn) return filtered;
        return [...filtered].sort((left, right) => {
          const a = left[orderColumn!];
          const b = right[orderColumn!];
          const compared = a === b ? 0 : a! > b! ? 1 : -1;
          return orderAscending ? compared : -compared;
        });
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select: () => builder,
        gte: (col: string, v: string) => {
          filters.push((r) => new Date(String(r[col])).getTime() >= new Date(v).getTime());
          return builder;
        },
        lte: (col: string, v: string) => {
          filters.push((r) => new Date(String(r[col])).getTime() <= new Date(v).getTime());
          return builder;
        },
        lt: (col: string, v: string) => {
          filters.push((r) => new Date(String(r[col])).getTime() < new Date(v).getTime());
          return builder;
        },
        gt: (col: string, v: string | number) => {
          filters.push((r) => r[col]! > v);
          return builder;
        },
        not: (col: string) => {
          filters.push((r) => r[col] != null);
          return builder;
        },
        like: (col: string, pattern: string) => {
          const prefix = pattern.replace(/%$/, "");
          filters.push((r) => String(r[col]).startsWith(prefix));
          return builder;
        },
        order: (col: string, options?: { ascending?: boolean }) => {
          orderColumn = col;
          orderAscending = options?.ascending !== false;
          return builder;
        },
        limit: (value: number) => {
          pageLimit = value;
          return builder;
        },
        range: (from: number, to: number) =>
          Promise.resolve({
            data: materialize().slice(from, to + 1),
            error: null,
          }),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve({
            data: materialize().slice(0, pageLimit ?? undefined),
            error: null,
          }).then(resolve, reject),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

let pass = 0;
let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${label}: got ${g}, want ${w}`);
  }
}

async function main() {
  // ── ① buildDateRange ─────────────────────────────
  const range = buildDateRange("2026-07-21");
  check("range length = 61", range.length, LOOKBACK_DAYS + 1);
  // baseline 보존: KST→UTC 슬라이스로 범위는 targetDate-1에서 끝 (기존 route와 결과 동일)
  check("range starts 61d ago (baseline)", range[0], "2026-05-21");
  check("range ends at target-1 (baseline)", range[range.length - 1], "2026-07-20");
  check(
    "range ascending",
    range.every((d, i) => i === 0 || d > range[i - 1]),
    true,
  );
  check("month boundary crossing", buildDateRange("2026-07-01", 1), ["2026-06-29", "2026-06-30"]);

  // ── ② resolveTargetDate (backfill 검증) ─────────────
  const today = "2026-07-21";
  check("null → today", resolveTargetDate(null, today), { ok: true, date: today });
  check("empty → today", resolveTargetDate("  ", today), { ok: true, date: today });
  check("backfill 7/19 ok", resolveTargetDate("2026-07-19", today), { ok: true, date: "2026-07-19" });
  check("backfill 7/20 ok", resolveTargetDate("2026-07-20", today), { ok: true, date: "2026-07-20" });
  check("today explicit ok", resolveTargetDate("2026-07-21", today), { ok: true, date: today });
  check("60d-old boundary ok", resolveTargetDate("2026-05-22", today).ok, true);
  check("61d-old rejected", resolveTargetDate("2026-05-21", today).ok, false);
  check("future rejected", resolveTargetDate("2026-07-22", today).ok, false);
  check("malformed rejected", resolveTargetDate("20260719", today).ok, false);
  check("garbage rejected", resolveTargetDate("abcd-ef-gh", today).ok, false);
  check("fake calendar day rejected", resolveTargetDate("2026-02-30", today).ok, false);
  check("sql-ish rejected", resolveTargetDate("2026-07-19'--", today).ok, false);

  // ── ③ collectGameDates ─────────────────────────────
  const dates10 = buildDateRange("2026-07-21", 9); // 10일치

  // (a) 전부 성공, 배치 경계 넘어도 입력 순서 보존
  {
    const withGames = new Set([dates10[1], dates10[4], dates10[8]]);
    const r = await collectGameDates(dates10, async (d) => withGames.has(d), { batchSize: 3 });
    check("order preserved across batches", r.gameDates, [dates10[1], dates10[4], dates10[8]]);
    check("no failures", r.failedDates, []);
    check("one attempt per date", r.fetchAttempts, 10);
  }

  // (b) transient 실패 → retry 패스에서 성공 (경기 있음 복구·무경기 취급 안 함)
  {
    const attempts = new Map<string, number>();
    const flaky = dates10[3];
    const r = await collectGameDates(
      dates10,
      async (d) => {
        const n = (attempts.get(d) ?? 0) + 1;
        attempts.set(d, n);
        if (d === flaky && n === 1) throw new Error("transient");
        return d === flaky || d === dates10[0];
      },
      { batchSize: 4 },
    );
    check("transient date recovered", r.gameDates.includes(flaky), true);
    check("recovered order preserved", r.gameDates, [dates10[0], flaky]);
    check("transient no residual failure", r.failedDates, []);
    check("retry only failed date", r.fetchAttempts, 11);
  }

  // (c) persistent 실패 → bounded retry 후 failedDates 반환 (fail-close 신호)
  {
    const attempts = new Map<string, number>();
    const dead = [dates10[2], dates10[7]];
    const r = await collectGameDates(
      dates10,
      async (d) => {
        attempts.set(d, (attempts.get(d) ?? 0) + 1);
        if (dead.includes(d)) throw new Error("down");
        return true;
      },
      { batchSize: 5 },
    );
    check("persistent failures reported (order)", r.failedDates, dead);
    check("failed not treated as no-game", dead.every((d) => !r.gameDates.includes(d)), true);
    check(
      "retry bounded per date",
      dead.every((d) => attempts.get(d) === 1 + MAX_RETRY_PASSES),
      true,
    );
    check("healthy dates unaffected", r.gameDates.length, 8);
  }

  // (d) route fail-close 계약: failedDates 있으면 gameday upsert 경로 진입 금지 (시뮬레이션)
  {
    const r = await collectGameDates(["2026-07-19"], async () => {
      throw new Error("always down");
    });
    const wouldUpsert = r.failedDates.length === 0;
    check("fail-close blocks upsert", wouldUpsert, false);
  }

  // ── ④ computeVisitDistribution targetDate 상한 (삼순 재현: 7/19 target + 7/20 유일 활동) ─
  {
    // 상한 없던 종전 코드엔 total=1로 오염되던 케이스 → 이제 빈 결과여야 함
    const sb = fakeSupabase({
      admin_page_view_user_days: [
        { id: 1, user_id: "userA", day_kst: "2026-07-20" },
      ],
    });
    const rows = await computeVisitDistribution(sb, "2026-07-19");
    check("future-only activity excluded (samsoon repro)", rows, []);
  }
  {
    // targetDate 당일(일말 직전 포함)까지만 집계, 이후 활동은 일 수 카운트에서 제외
    const sb = fakeSupabase({
      posts: [{ author_id: "userB", created_at: "2026-07-18T12:00:00+09:00" }],
      likes: [{ user_id: "userB", created_at: "2026-07-19T23:30:00+09:00" }],
      chat_messages: [{ user_id: "userB", created_at: "2026-07-21T09:00:00+09:00" }],
      admin_page_view_user_days: [{ id: 1, user_id: "userA", day_kst: "2026-07-20" }],
    });
    const rows = await computeVisitDistribution(sb, "2026-07-19");
    const b2 = rows.find((r) => r.metric_key === "2");
    check("in-range days counted (2 days → bucket 2)", b2?.value, 1);
    check("total excludes future-only user", b2?.total, 1);
    check("row dated targetDate", b2?.date, "2026-07-19");
    check(
      "future day not inflating bucket (no bucket 3)",
      rows.find((r) => r.metric_key === "3")?.value,
      0,
    );
  }
  {
    // 오늘 실행(정기 cron) 경로 회귀: 당일 활동 정상 집계
    const sb = fakeSupabase({
      posts: [{ author_id: "userC", created_at: "2026-07-21T08:00:00+09:00" }],
    });
    const rows = await computeVisitDistribution(sb, "2026-07-21");
    check("same-day activity counted (regular run)", rows.find((r) => r.metric_key === "1")?.value, 1);
  }
  {
    const sb = fakeSupabase({
      profiles: [
        { id: "userA", team_id: 1, favorite_players: ["p1"], created_at: "2026-07-01T10:00:00+09:00" },
        { id: "userB", team_id: 2, favorite_players: ["p2"], created_at: "2026-07-02T10:00:00+09:00" },
      ],
      admin_user_game_lifetime: [
        { user_id: "userA", first_game_id: "20260720LGOB", first_game_day_kst: "2026-07-20" },
      ],
    });
    const rows = await computeActivationFunnel(sb, "2026-07-21");
    check("lifetime game state feeds activation", rows.find((r) => r.metric_key === "games_1plus")?.value, 1);
    check("activation still requires all three steps", rows.find((r) => r.metric_key === "activated")?.value, 1);
  }
  {
    // 삼순 P1-2 회귀(PR #773): 365일 purge로 user-day rollup이 사라져도
    // lifetime 상태로 활성화 증거가 유지되고, targetDate 이후 최초방문은 제외된다.
    const sb = fakeSupabase({
      profiles: [
        { id: "userOld", team_id: 1, favorite_players: ["p1"], created_at: "2026-06-27T10:00:00+09:00" },
        { id: "userLate", team_id: 2, favorite_players: ["p2"], created_at: "2026-06-28T10:00:00+09:00" },
      ],
      admin_user_game_lifetime: [
        { user_id: "userOld", first_game_id: "20260628LGOB", first_game_day_kst: "2026-06-28" },
        { user_id: "userLate", first_game_id: "20270722SSLT", first_game_day_kst: "2027-07-22" },
      ],
      admin_page_view_user_days: [], // 365일 purge 이후 과거 user-day는 비어 있음
    });
    const rows = await computeActivationFunnel(sb, "2027-07-21");
    check("365d purge keeps lifetime games_1plus", rows.find((r) => r.metric_key === "games_1plus")?.value, 1);
    check("365d purge keeps activated", rows.find((r) => r.metric_key === "activated")?.value, 1);
  }
  {
    // 삼순 3차 재현: 마지막 1초 fractional timestamp 포함 + 익일 00:00 exclusive 제외
    const sb = fakeSupabase({
      posts: [{ author_id: "userD", created_at: "2026-07-19T23:59:59.500+09:00" }],
      likes: [{ user_id: "userE", created_at: "2026-07-20T00:00:00+09:00" }],
    });
    const rows = await computeVisitDistribution(sb, "2026-07-19");
    const b1 = rows.find((r) => r.metric_key === "1");
    check("fractional last-second included (23:59:59.500)", b1?.value, 1);
    check("next-day 00:00 exclusive", b1?.total, 1);
  }

  // ── ⑤ isBackfill (funnel 제외 계약) ───────────────
  check("backfill: past date", isBackfill("2026-07-19", "2026-07-21"), true);
  check("backfill: yesterday", isBackfill("2026-07-20", "2026-07-21"), true);
  check("regular: today", isBackfill("2026-07-21", "2026-07-21"), false);

  console.log(`retention-gamedates smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
