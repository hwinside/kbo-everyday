/**
 * 스모크: retention cron 경기일 수집·backfill 정책 — 2026-07-21 (PR #736 삼순 리뷰 반영).
 *   ① buildDateRange: 61일 범위·오름차순·월 경계
 *   ② resolveTargetDate: 기본 오늘 / 과거 소급 허용 / 형식·실존일·미래·60일 초과 거부
 *   ③ collectGameDates: 순서 보존·부분 실패 bounded retry·잔여 실패 fail-close 신호·재시도 상한
 * 실행: npm run qa:retention-dates
 */
import {
  buildDateRange,
  resolveTargetDate,
  collectGameDates,
  LOOKBACK_DAYS,
  MAX_RETRY_PASSES,
} from "../../src/lib/retention/gamedates";

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

  console.log(`retention-gamedates smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
