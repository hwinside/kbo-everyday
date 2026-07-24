/**
 * 스모크: 롤링 윈도우 리텐션 계산 — 2026-07-25 (D14>D7 역전 검증 후속, 셀링 곡선용 추가 뷰).
 *   ① 윈도우 귀속: day3→W1, day10→W2 (경계 day7=W1 / day8=W2)
 *   ② "구간 1회+" 멱등: 한 윈도우 안 다중 활동일도 1회로 카운트
 *   ③ eligibility 게이트: 윈도우 마지막 날 미경과(오늘 포함) 코호트는 행 제외
 *   ④ 무경기일 노이즈 흡수: exact-day면 0이 될 무경기일 착지 유저도 윈도우 내 다른 날 활동으로 잔존
 * 실행: npm run qa:retention-rolling
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeRollingRetention } from "../../src/lib/retention/compute";

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

function rate(rows: Awaited<ReturnType<typeof computeRollingRetention>>, week: string, w: string) {
  return rows.find((r) => r.cohort_key === week && r.metric_key === w);
}

async function main() {
  const TARGET = "2026-08-01"; // W27 코호트(06-29~07-05)의 w4(=+28일=07-27~07-31) 전부 경과
  // 코호트 주차 = 06-30 가입 → 2026-W27 (>= MIN_COHORT). 활동은 posts.created_at KST 일자로 귀속.
  const p = (id: string, d: string) => ({ id, created_at: `${d}T09:00:00+09:00` });
  const act = (uid: string, d: string) => ({ author_id: uid, created_at: `${d}T20:00:00+09:00` });

  // ── ①②④ 윈도우 귀속 + 1회+ 멱등 + 무경기일 흡수 ──
  {
    const sb = fakeSupabase({
      profiles: [p("A", "2026-06-30"), p("B", "2026-06-30"), p("C", "2026-06-30")],
      posts: [
        act("A", "2026-07-03"),                       // day3 → W1
        act("B", "2026-07-10"),                       // day10 → W2 (W1엔 활동 0 = exact-day면 D1~D7 전부 0이었을 유저)
        act("C", "2026-07-05"), act("C", "2026-07-06"), // day5,6 같은 W1 → 1회로만
      ],
      comments: [], likes: [], chat_messages: [], admin_page_views: [],
    });
    const rows = await computeRollingRetention(sb, TARGET);
    const week = rows[0]?.cohort_key ?? "?";
    check("cohort week >= W27", week >= "2026-W27", true);
    check("W1 eligible=3", rate(rows, week, "w1")?.total, 3);
    check("W1 returned=2 (A,C)", rate(rows, week, "w1")?.value, 2);
    check("W1 dup-day counted once (C)", rate(rows, week, "w1")?.rate, 0.6667);
    check("W2 returned=1 (B)", rate(rows, week, "w2")?.value, 1);
    check("W3 returned=0", rate(rows, week, "w3")?.value, 0);
    check("W4 returned=0", rate(rows, week, "w4")?.value, 0);
  }

  // ── ① 경계: day7=W1, day8=W2 ──
  {
    const sb = fakeSupabase({
      profiles: [p("D", "2026-06-30"), p("E", "2026-06-30")],
      posts: [act("D", "2026-07-07"), act("E", "2026-07-08")], // D=day7, E=day8
      comments: [], likes: [], chat_messages: [], admin_page_views: [],
    });
    const rows = await computeRollingRetention(sb, TARGET);
    const week = rows[0]?.cohort_key ?? "?";
    check("day7 → W1 (boundary)", rate(rows, week, "w1")?.value, 1);
    check("day8 → W2 (boundary)", rate(rows, week, "w2")?.value, 1);
    check("day7 not in W2", rate(rows, week, "w2")?.value, 1); // only E, not D
  }

  // ── ③ eligibility: 윈도우 미경과 코호트는 행 없음 ──
  {
    // 07-28 가입 → w1 마지막날 = 08-04 >= 08-01 → eligible 0 → 해당 주 행 없음
    const sb = fakeSupabase({
      profiles: [p("F", "2026-07-28")],
      posts: [act("F", "2026-07-30")],
      comments: [], likes: [], chat_messages: [], admin_page_views: [],
    });
    const rows = await computeRollingRetention(sb, TARGET);
    check("unelapsed cohort → no rows", rows.length, 0);
  }

  // ── ③ 부분 eligibility: w1만 경과, w2~는 미경과 ──
  {
    // 07-20 가입, target 07-28 → w1끝 07-27 < 07-28 경과 / w2끝 08-03 미경과
    const sb = fakeSupabase({
      profiles: [p("G", "2026-07-20")],
      posts: [act("G", "2026-07-22")], // day2 → W1
      comments: [], likes: [], chat_messages: [], admin_page_views: [],
    });
    const rows = await computeRollingRetention(sb, "2026-07-28");
    const week = rows[0]?.cohort_key ?? "?";
    check("partial: only W1 row exists", rows.map((r) => r.metric_key).sort(), ["w1"]);
    check("partial: W1 returned", rate(rows, week, "w1")?.value, 1);
  }

  console.log(`retention-rolling smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
