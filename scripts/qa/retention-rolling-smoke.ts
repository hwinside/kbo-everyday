/**
 * 스모크: 고정 horizon Rolling Retention (computeCohortRetention 내 metric_type="rolling")
 *   — 2026-07-25 삼순 리뷰 2차 반영 (28일만 쓰면 W27 D28 미성숙으로 차트 빈다 →
 *     14일+28일 두 horizon 병행, 실제 n 노출, 현재일·주내 혼합성숙 회귀).
 *   ① 앵커 귀속: h{H}_r{k} = [Dk, DH] 중 1회+ (H∈{14,28})
 *   ② 단조 비증가: 각 horizon 내 R1≥R7≥… (구간 포함관계+동일 분모)
 *   ③ 14일 성숙/28일 미성숙: 지금 데이터로 h14만 노출, h28 빈 케이스(핵심 삼순 blocker)
 *   ④ 현재일 경계: DH == targetDate 유저는 미성숙(>=)으로 제외
 *   ⑤ 주내 혼합성숙: 같은 주 성숙 유저만 분모(동일 분모), n(total) 노출
 *   ⑥ "1회+" 멱등 + cohort exact-day 동시 생성
 * 실행: npm run qa:retention-rolling
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeCohortRetention } from "../../src/lib/retention/compute";

type Row = Record<string, unknown>;
function fakeSupabase(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: ((r: Row) => boolean)[] = [];
      let sortCol: string | null = null;
      let limitN: number | null = null;
      const result = () => {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (sortCol !== null) {
          const col = sortCol;
          out = [...out].sort((a, b) => ((a[col] as number) > (b[col] as number) ? 1 : -1));
        }
        if (limitN !== null) out = out.slice(0, limitN);
        return out;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select: () => builder,
        gte: (col: string, v: string) => { filters.push((r) => new Date(String(r[col])).getTime() >= new Date(v).getTime()); return builder; },
        lte: (col: string, v: string) => { filters.push((r) => new Date(String(r[col])).getTime() <= new Date(v).getTime()); return builder; },
        lt: (col: string, v: string) => { filters.push((r) => new Date(String(r[col])).getTime() < new Date(v).getTime()); return builder; },
        not: (col: string) => { filters.push((r) => r[col] != null); return builder; },
        gt: (col: string, v: unknown) => { filters.push((r) => (r[col] as number) > (v as number)); return builder; },
        like: (col: string, pattern: string) => { const prefix = pattern.replace(/%$/, ""); filters.push((r) => String(r[col]).startsWith(prefix)); return builder; },
        order: (col: string) => { sortCol = col; return builder; },
        limit: (n: number) => { limitN = n; return builder; },
        range: (from: number, to: number) => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(from, to + 1), error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: result(), error: null }).then(resolve),
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
  if (g === w) pass++;
  else { fail++; console.error(`  ✗ ${label}: got ${g}, want ${w}`); }
}

type MetricRow = Awaited<ReturnType<typeof computeCohortRetention>>[number];
function roll(rows: MetricRow[], week: string, key: string) {
  return rows.find((r) => r.metric_type === "rolling" && r.cohort_key === week && r.metric_key === key);
}
function rollingKeys(rows: MetricRow[]) {
  return rows.filter((r) => r.metric_type === "rolling").map((r) => r.metric_key);
}

async function main() {
  const p = (id: string, d: string) => ({ id, created_at: `${d}T09:00:00+09:00` });
  const act = (uid: string, d: string) => ({ author_id: uid, created_at: `${d}T20:00:00+09:00` });
  const empties = { comments: [], likes: [], chat_messages: [], admin_page_views: [] };

  // ── ③④ 14일 성숙 / 28일 미성숙 (핵심 blocker 재현) + 단조 + 앵커 귀속 ──
  {
    // signup 06-30, TARGET 07-16: D14=07-14<07-16 성숙 / D28=07-28>=07-16 미성숙
    const TARGET = "2026-07-16";
    const sb = fakeSupabase({
      profiles: [p("A", "2026-06-30"), p("B", "2026-06-30"), p("C", "2026-06-30"), p("D", "2026-06-30")],
      posts: [
        act("A", "2026-07-10"),  // day10 → h14_r1,h14_r7 (r14=D14만이라 제외)
        act("B", "2026-07-14"),  // day14 → h14_r1,r7,r14
        act("C", "2026-07-03"),  // day3  → h14_r1만
        // D 무활동
      ],
      ...empties,
    });
    const rows = await computeCohortRetention(sb, TARGET);
    const week = rows.find((r) => r.metric_type === "rolling")?.cohort_key ?? "?";
    // h28은 미성숙이라 전무
    check("28일 horizon 미성숙 → h28 없음", rollingKeys(rows).some((k) => k.startsWith("h28_")), false);
    check("14일 horizon 노출 → h14 있음", rollingKeys(rows).some((k) => k.startsWith("h14_")), true);
    check("h14_r1 eligible n=4", roll(rows, week, "h14_r1")?.total, 4);
    check("h14_r1 returned=3 (A,B,C)", roll(rows, week, "h14_r1")?.value, 3);
    check("h14_r7 returned=2 (A,B)", roll(rows, week, "h14_r7")?.value, 2);
    check("h14_r14 returned=1 (B, day14)", roll(rows, week, "h14_r14")?.value, 1);
    const seq = ["h14_r1", "h14_r7", "h14_r14"].map((k) => roll(rows, week, k)!.rate);
    check("h14 monotone R1≥R7≥R14", seq.every((v, i) => i === 0 || v <= seq[i - 1]), true);
  }

  // ── ②⑥ 두 horizon 모두 성숙 + 멱등 + cohort 동시 생성 ──
  {
    const TARGET = "2026-08-01"; // signup 06-30 → D28=07-28<08-01 성숙
    const sb = fakeSupabase({
      profiles: [p("A", "2026-06-30"), p("B", "2026-06-30")],
      posts: [
        act("A", "2026-07-10"), act("A", "2026-07-25"), // day10,25 (25∈[21,28],[14,28] 등)
        act("B", "2026-07-28"),                          // day28
      ],
      ...empties,
    });
    const rows = await computeCohortRetention(sb, TARGET);
    const week = rows.find((r) => r.metric_type === "rolling")?.cohort_key ?? "?";
    check("both horizons present (h14+h28)", ["h14_r1", "h28_r1", "h28_r28"].every((k) => roll(rows, week, k)), true);
    // h28: A(10,25)/B(28). r1[1,28]:둘다 / r7[7,28]:둘다 / r14[14,28]:A(25),B(28) / r21[21,28]:A(25),B(28) / r28:B
    check("h28_r1 returned=2", roll(rows, week, "h28_r1")?.value, 2);
    check("h28_r14 returned=2 (A25,B28)", roll(rows, week, "h28_r14")?.value, 2);
    check("h28_r28 returned=1 (B)", roll(rows, week, "h28_r28")?.value, 1);
    const seq28 = ["h28_r1", "h28_r7", "h28_r14", "h28_r21", "h28_r28"].map((k) => roll(rows, week, k)!.rate);
    check("h28 monotone R1≥R7≥R14≥R21≥R28", seq28.every((v, i) => i === 0 || v <= seq28[i - 1]), true);
    check("A multi-day counted once in h28_r7", roll(rows, week, "h28_r7")?.value, 2);
    // cohort exact-day 동시 생성(추가 스캔 없이)
    check("cohort rows still produced", rows.some((r) => r.metric_type === "cohort"), true);
  }

  // ── ④ 현재일 경계: DH == targetDate 유저는 미성숙(>=)으로 제외 ──
  {
    const TARGET = "2026-07-16";
    const sb = fakeSupabase({
      profiles: [p("E", "2026-07-01"), p("F", "2026-07-02")], // E:D14=07-15<16 성숙 / F:D14=07-16==16 미성숙
      posts: [act("E", "2026-07-05"), act("F", "2026-07-05")],
      ...empties,
    });
    const rows = await computeCohortRetention(sb, TARGET);
    const week = rows.find((r) => r.metric_type === "rolling")?.cohort_key ?? "?";
    check("current-day boundary: DH==target 제외 → n=1 (E만)", roll(rows, week, "h14_r1")?.total, 1);
  }

  // ── ⑤ 주내 혼합성숙: 같은 주 성숙 유저만 분모(n 노출) ──
  {
    const TARGET = "2026-08-01";
    // 같은 W27? 06-30(D28=07-28 성숙) + 07-05(D28=08-02>=08-01 미성숙) — 둘 다 W27 근방
    const sb = fakeSupabase({
      profiles: [p("G", "2026-06-30"), p("H", "2026-07-05")],
      posts: [act("G", "2026-07-10"), act("H", "2026-07-10")],
      ...empties,
    });
    const rows = await computeCohortRetention(sb, TARGET);
    // G(06-30 W27)만 h28 성숙, H(07-05)는 주가 다르거나 미성숙 → h28에서 G의 주만 n=1
    const h28weeks = rows.filter((r) => r.metric_type === "rolling" && r.metric_key === "h28_r1");
    const totalN = h28weeks.reduce((s, r) => s + r.total, 0);
    check("mixed-maturity h28: 성숙 유저만 분모 총합 n=1", totalN, 1);
  }

  console.log(`retention-rolling smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
