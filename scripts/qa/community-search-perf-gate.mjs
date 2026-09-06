#!/usr/bin/env node
/**
 * 커뮤니티 검색 v1 — 성능 게이트 (삼순 리뷰 ③ + 정정 ②).
 *
 * "Seq Scan 이냐" 가 아니라 **유저가 실제로 겪는 응답시간**으로 판정한다:
 *  (1) PostgREST 경유 RPC + `profiles(...)` 임베딩까지 포함한 end-to-end 지연(p50/p95, N회 반복)
 *  (2) DB 안 `explain (analyze, buffers)` — 인덱스 사용 여부·실행시간·읽은 블록(shared hit/read)
 * 케이스: 흔한 2자 / 3자 / 무결과 / 후속 페이지(before_id) / 대조군 = 기존 일반 피드 1페이지(같은 SELECT).
 *
 * 허용 기준(초기값 — 하린아빠·삼순 합의로 조정):
 *   E2E p95 ≤ PERF_P95_MS(기본 800ms)  AND  E2E p50 ≤ 대조군 p50 × PERF_RATIO(기본 2.5)
 *   위반 시 exit 1 + 어떤 케이스가 넘었는지 표로 출력. 2자 케이스가 넘으면 SEARCH_MIN_LEN 3 전환(UX 결정) 안건으로 올린다.
 *
 * 실행 시점: migration(인덱스·함수) 적용 직후, 머지 전. 결과 표를 스레드에 그대로 첨부한다.
 *   npm run qa:community-search:perf            # .env.local 의 anon key + SUPABASE_MANAGEMENT_TOKEN 필요
 *   PERF_Q2=직관 PERF_Q3=직관러 PERF_QNONE=zzqxjv PERF_N=15 node scripts/qa/community-search-perf-gate.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, ANON, REF } from "./_env.mjs";

const MGMT = process.env.SUPABASE_MANAGEMENT_TOKEN || "";
const N = Number(process.env.PERF_N || 12);
const P95_MS = Number(process.env.PERF_P95_MS || 800);
const RATIO = Number(process.env.PERF_RATIO || 2.5);
const Q2 = process.env.PERF_Q2 || "직관";
const Q3 = process.env.PERF_Q3 || "직관러";
const QNONE = process.env.PERF_QNONE || "zzqxjv";

const SELECT =
  "id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, is_hidden, game_id, player_tags, team_tags, hashtags, author_team_id_snapshot, click_view_count, impression_view_count, profiles(nickname, team_id, grade, points, avatar_url)";

const anon = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function timeIt(label, fn) {
  const times = [];
  let rows = 0;
  let extra = null;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const r = await fn(extra);
    const dt = performance.now() - t0;
    if (r.error) throw new Error(`${label}: ${r.error.message}`);
    times.push(dt);
    rows = r.data?.length ?? 0;
    if (extra === null && rows) extra = r.data[rows - 1].id; // 후속 페이지용 커서
  }
  return { label, rows, p50: Math.round(pct(times, 50)), p95: Math.round(pct(times, 95)), max: Math.round(Math.max(...times)) };
}

// plpgsql 함수를 explain 하면 최상위 plan 이 Function Scan 으로만 보여 내부 인덱스 사용이 안 드러난다.
// 그래서 함수 본문과 동일한 SQL 을 직접 explain 한다(E2E 지연은 위 timeIt 이 실제 RPC 로 측정).
// HTTP 오류·파싱 실패는 { failed: true } 로 반환 — 호출자가 판정에 포함시킨다.
async function explainInline(label, q, beforeId) {
  if (!MGMT) return { label, failed: true, note: "SUPABASE_MANAGEMENT_TOKEN 없음" };
  const esc = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/'/g, "''");
  const sql = `explain (analyze, buffers, format json)
    select p.* from public.posts p
    where p.is_hidden is not true and p.board_type in ('team','player','free','poll')
      and (p.title ilike '%${esc}%' escape '\\' or p.content ilike '%${esc}%' escape '\\')
      and (${beforeId ?? "null"}::bigint is null or p.id < ${beforeId ?? "null"}::bigint)
    order by p.id desc limit 20`;
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MGMT}`, "Content-Type": "application/json", "User-Agent": "curl/8.4.0" },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) return { label, failed: true, note: `explain HTTP ${r.status}` };
  const body = await r.json();
  const root = body?.[0]?.["QUERY PLAN"]?.[0];
  if (!root) return { label, failed: true, note: "explain 응답 파싱 실패" };
  const nodes = [];
  let hit = 0;
  let read = 0;
  (function walk(n) {
    if (!n) return;
    nodes.push(n["Node Type"] + (n["Index Name"] ? `(${n["Index Name"]})` : ""));
    hit = Math.max(hit, n["Shared Hit Blocks"] ?? 0);
    read = Math.max(read, n["Shared Read Blocks"] ?? 0);
    (n.Plans ?? []).forEach(walk);
  })(root?.Plan);
  return {
    label,
    failed: false,
    execMs: root?.["Execution Time"] != null ? Number(root["Execution Time"]).toFixed(1) : undefined,
    indexUsed: nodes.some((x) => /idx_posts_(title|content)_trgm/.test(x)),
    seqScan: nodes.some((x) => x.startsWith("Seq Scan")),
    sharedHit: hit,
    sharedRead: read,
  };
}

(async () => {
  console.log(`커뮤니티 검색 성능 게이트 — N=${N}, 기준 p95≤${P95_MS}ms, p50≤대조군×${RATIO}`);

  // 2페이지 측정 전 실제 커서 확보 — before_id=null 로 1페이지 사전 조회.
  // 결과 없으면 Q2 가 DB 에 없는 것 → PERF_Q2 를 실존하는 검색어로 교체해야 함.
  const q2Pre = await anon.rpc("search_posts", { q: Q2, before_id: null, page_size: 20 }).select("id");
  if (q2Pre.error) throw new Error(`Q2 사전 조회 실패: ${q2Pre.error.message}`);
  const q2Cursor = q2Pre.data?.length ? q2Pre.data[q2Pre.data.length - 1].id : null;
  if (!q2Cursor) {
    console.error(`✗ Q2("${Q2}") 1페이지 결과 없음 — 2페이지 표본 확보 불가. PERF_Q2 를 결과가 있는 검색어로 변경하세요.`);
    process.exit(1);
  }

  // query-guard: bounded -- 대조군 = useUnifiedFeed 일반 피드 1페이지와 동일 쿼리(id desc, .limit(20) 고정, 1페이지만 측정).
  const baseline = await timeIt("대조군: 일반 피드 1페이지", () =>
    anon.from("posts").select(SELECT).neq("is_hidden", true).in("board_type", ["team", "player", "free", "poll"]).order("id", { ascending: false }).limit(20),
  );
  const cases = [
    await timeIt(`2자 "${Q2}" 1페이지`, () => anon.rpc("search_posts", { q: Q2, before_id: null, page_size: 20 }).select(SELECT)),
    // q2Cursor 고정 — timeIt 의 extra(동적 cursor) 대신 사전 확보한 실제 2페이지 커서를 씀.
    await timeIt(`2자 "${Q2}" 후속 페이지(cursor=${q2Cursor})`, () => anon.rpc("search_posts", { q: Q2, before_id: q2Cursor, page_size: 20 }).select(SELECT)),
    await timeIt(`3자 "${Q3}" 1페이지`, () => anon.rpc("search_posts", { q: Q3, before_id: null, page_size: 20 }).select(SELECT)),
    await timeIt(`무결과 "${QNONE}"`, () => anon.rpc("search_posts", { q: QNONE, before_id: null, page_size: 20 }).select(SELECT)),
  ];

  console.log("\n[E2E PostgREST RPC + profiles 임베딩] (ms)");
  console.table([baseline, ...cases].map(({ label, rows, p50, p95, max }) => ({ label, rows, p50, p95, max })));

  console.log("\n[DB explain (analyze, buffers) — 함수 본문과 동일 SQL]");
  const ex = [
    await explainInline(`2자 "${Q2}" 1페이지`, Q2, null),
    await explainInline(`2자 "${Q2}" 2페이지(cursor=${q2Cursor})`, Q2, q2Cursor),
    await explainInline(`3자 "${Q3}" 1페이지`, Q3, null),
    await explainInline(`무결과 "${QNONE}"`, QNONE, null),
  ];
  console.table(ex);

  const fails = [];
  // E2E 지연 판정
  for (const c of cases) {
    if (c.p95 > P95_MS) fails.push(`${c.label}: p95 ${c.p95}ms > ${P95_MS}ms`);
    if (c.p50 > baseline.p50 * RATIO) fails.push(`${c.label}: p50 ${c.p50}ms > 대조군 ${baseline.p50}ms × ${RATIO}`);
  }
  // explain 판정 — 측정 실패(토큰 없음·HTTP 오류)는 FAIL, Seq Scan 감지도 FAIL.
  for (const e of ex) {
    if (e.failed) {
      fails.push(`explain ${e.label}: 측정 실패 — ${e.note}`);
    } else {
      if (!e.indexUsed) fails.push(`explain ${e.label}: trgm 인덱스 미사용`);
      if (e.seqScan) fails.push(`explain ${e.label}: Seq Scan 감지 — 인덱스 미적용 가능`);
    }
  }
  if (fails.length) {
    console.error("\n✗ 성능 게이트 FAIL\n  - " + fails.join("\n  - "));
    process.exit(1);
  }
  console.log("\n✓ 성능 게이트 PASS");
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(2);
});
