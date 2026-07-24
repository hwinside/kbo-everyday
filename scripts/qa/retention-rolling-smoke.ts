/**
 * 스모크: 28일 고정 Rolling Retention (computeCohortRetention 내 metric_type="rolling")
 *   — 2026-07-25 삼순 리뷰 반영 (주간 비겹침 W1~W4 → 단조 비보장 지적 → 28일 고정으로 교체).
 *   ① 앵커 귀속: R1=[D1,28]/R7=[D7,28]/R14=[D14,28]/R21=[D21,28]/R28=D28 중 1회+
 *   ② 단조 비증가 보장: R1≥R7≥R14≥R21≥R28 (구간 포함관계+동일 분모)
 *   ③ eligibility: D28 미성숙 코호트/유저는 R 전체에서 제외(동일 분모 유지)
 *   ④ "1회+" 멱등: 한 구간 내 다중 활동일도 1회
 *   ⑤ 추가 스캔 0: cohort와 같은 함수/스캔에서 rolling row 생성
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
function rolling(rows: MetricRow[], week: string, key: string) {
  return rows.find((r) => r.metric_type === "rolling" && r.cohort_key === week && r.metric_key === key);
}

async function main() {
  const TARGET = "2026-08-01"; // W27(06-30 가입)의 D28=07-28 < 08-01 → 성숙
  const p = (id: string, d: string) => ({ id, created_at: `${d}T09:00:00+09:00` });
  const act = (uid: string, d: string) => ({ author_id: uid, created_at: `${d}T20:00:00+09:00` });

  // ── ①②④ 앵커 귀속 + 단조 + 멱등 ──
  {
    const sb = fakeSupabase({
      profiles: [p("A", "2026-06-30"), p("B", "2026-06-30"), p("C", "2026-06-30"), p("D", "2026-06-30"), p("E", "2026-06-30")],
      posts: [
        act("A", "2026-07-01"),                        // day1 → R1만
        act("B", "2026-07-28"),                        // day28 → R1~R28 전부
        act("C", "2026-07-15"),                        // day15 → R1/R7/R14 (R21은 15<21 제외)
        act("E", "2026-07-10"), act("E", "2026-07-20"), // day10,20 둘 다 [D7,28] → 1회로만
        // D = 무활동
      ],
      comments: [], likes: [], chat_messages: [], admin_page_views: [],
    });
    const rows = await computeCohortRetention(sb, TARGET);
    const week = rows.find((r) => r.metric_type === "rolling")?.cohort_key ?? "?";
    check("cohort week >= W27", week >= "2026-W27", true);
    // eligible=5 전 앵커 동일
    check("R1 eligible=5", rolling(rows, week, "r1")?.total, 5);
    check("R28 eligible=5 (동일 분모)", rolling(rows, week, "r28")?.total, 5);
    // returned: R1=A,B,C,E=4 / R7=B,C,E=3 / R14=B,C,E(day20∈[14,28])=3 / R21=B=1 / R28=B=1
    check("R1 returned=4 (A,B,C,E)", rolling(rows, week, "r1")?.value, 4);
    check("R7 returned=3 (B,C,E)", rolling(rows, week, "r7")?.value, 3);
    check("R14 returned=3 (B,C,E day20∈[14,28])", rolling(rows, week, "r14")?.value, 3);
    check("R21 returned=1 (B)", rolling(rows, week, "r21")?.value, 1);
    check("R28 returned=1 (B, day28)", rolling(rows, week, "r28")?.value, 1);
    // 단조 비증가
    const seq = ["r1", "r7", "r14", "r21", "r28"].map((k) => rolling(rows, week, k)!.rate);
    check("monotone non-increasing R1≥R7≥R14≥R21≥R28", seq.every((v, i) => i === 0 || v <= seq[i - 1]), true);
    check("E multi-day counted once in R7", rolling(rows, week, "r7")?.value, 3);
  }

  // ── ③ eligibility: D28 미성숙 코호트는 rolling row 없음 ──
  {
    // 07-20 가입 → D28=08-17 >= 08-01 미성숙 → 해당 주 rolling 없음
    const sb = fakeSupabase({
      profiles: [p("F", "2026-07-20")],
      posts: [act("F", "2026-07-22")],
      comments: [], likes: [], chat_messages: [], admin_page_views: [],
    });
    const rows = await computeCohortRetention(sb, TARGET);
    check("immature cohort → no rolling rows", rows.filter((r) => r.metric_type === "rolling").length, 0);
  }

  // ── ③ 같은 주 내 미성숙 유저는 분모에서 제외(동일 분모 보장) ──
  {
    // 07-04(성숙 D28=08-01? 08-01은 target과 같아 >= 제외) → 07-03 가입 D28=07-31<08-01 성숙
    // 같은 W27 주에 성숙 G(07-03)+미성숙 H(07-05: D28=08-02>=08-01)
    const sb = fakeSupabase({
      profiles: [p("G", "2026-07-03"), p("H", "2026-07-05")],
      posts: [act("G", "2026-07-10"), act("H", "2026-07-10")],
      comments: [], likes: [], chat_messages: [], admin_page_views: [],
    });
    const rows = await computeCohortRetention(sb, TARGET);
    const week = rows.find((r) => r.metric_type === "rolling")?.cohort_key ?? "?";
    check("mixed-maturity: only mature G counted (eligible=1)", rolling(rows, week, "r1")?.total, 1);
    check("mixed-maturity: R1 returned=1 (G day7)", rolling(rows, week, "r1")?.value, 1);
  }

  // ── ⑤ cohort exact-day 회귀 동시 존재(추가 스캔 없이 같은 함수서 생성) ──
  {
    const sb = fakeSupabase({
      profiles: [p("A", "2026-06-30")],
      posts: [act("A", "2026-07-07")], // day7
      comments: [], likes: [], chat_messages: [], admin_page_views: [],
    });
    const rows = await computeCohortRetention(sb, TARGET);
    check("cohort(exact-day) rows still produced", rows.some((r) => r.metric_type === "cohort"), true);
    check("rolling rows produced by same fn", rows.some((r) => r.metric_type === "rolling"), true);
    const week = rows.find((r) => r.metric_type === "rolling")?.cohort_key ?? "?";
    check("exact D7=1 (day7 활동)", rows.find((r) => r.metric_type === "cohort" && r.cohort_key === week && r.metric_key === "D7")?.value, 1);
  }

  console.log(`retention-rolling smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
