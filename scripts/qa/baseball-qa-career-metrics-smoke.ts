/**
 * 통산 다지표 리더보드 게이트.
 *
 * 계약:
 *   ⓐ 지원 지표는 **종단(`answerQuestion`)에서 실제 값**으로 답한다 — 라우터만 보면 production 을
 *     증명하지 못한다(#1164 5차 교훈).
 *   ⓑ 값은 **기준선 + 당해 증분** 이 공식 통산표와 일치한다(추정·재계산 금지).
 *   ⓒ 미지원·모호·복수절은 fail-close 하고 generic LLM 으로 새지 않는다.
 *   ⓓ #1159(안타)·#1164(누수 차단) 무회귀.
 *
 * ⚠️ **fixture 를 손으로 짓지 않는다**(오늘 2회 사고). 기대 선수·값은 전부 스냅샷 JSON 과
 *   서빙 static 에서 **기계로 계산**해 만든다. 내가 아는 이름을 적으면 그건 검증이 아니라 암기다.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import baseline from "../../data/baseball-qa/kbo-career-metrics-through-2025.json";
import batters from "../../src/lib/constants/stats-2026-batters.json";
import pitchers from "../../src/lib/constants/stats-2026-pitchers.json";
import {
  CAREER_METRICS_BY_TABLE,
  matchCareerMetric,
  type CareerTable,
} from "../../src/lib/baseball-qa/stats/career-metric-catalog";
import {
  CAREER_RANK_MAX,
  composeCareerMetricAnswer,
  createCareerMetricLeaderboardFetcher,
  resolveCareerMetricIntent,
  resolveCareerMetricLeaderboard,
} from "../../src/lib/baseball-qa/stats/career-metric-leaderboard";
import { answerQuestion, routeQuestion, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import { validateServedPitcherPayload } from "../../src/lib/baseball-qa/stats/served-record";
import { FULL_ENTRY_PITCHER_IDS } from "../../src/lib/stats/full-entry-roster";
import type { SeasonRecordRow } from "../../src/lib/baseball-qa/stats/season-record";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
}
const asyncChecks: Array<[string, () => Promise<void>]> = [];
function checkAsync(name: string, fn: () => Promise<void>) { asyncChecks.push([name, fn]); }

const NOW = new Date("2026-08-12T12:00:00Z");
const SERVED_AT = "2026-08-12T11:00:00Z";

function toRows(src: Array<Record<string, unknown>>): SeasonRecordRow[] {
  return src.filter((r) => r.kboId).map((r) => ({
    ...r,
    player_key: String(r.kboId), kbo_id: String(r.kboId),
    name: String(r.name ?? ""), team: (r.team as string) ?? null, updated_at: SERVED_AT,
  })) as SeasonRecordRow[];
}
const SERVED: Record<CareerTable, SeasonRecordRow[]> = {
  batter: toRows(batters as never),
  pitcher: toRows(pitchers as never),
};
const fetcher = createCareerMetricLeaderboardFetcher(
  () => baseline,
  async (table) => ({ rows: SERVED[table], updatedAt: SERVED_AT }),
);

/** 기대값을 **독립 경로로 재계산**한다 — 대상 로직을 재구현하지 않고 원자료만 더한다. */
function expectedLeader(table: CareerTable, metric: string): { name: string; total: number } {
  const currentById = new Map(SERVED[table].map((r) => [String(r.kbo_id), r]));
  const spec = CAREER_METRICS_BY_TABLE[table].find((s) => s.key === metric)!;
  let best: { name: string; total: number } | null = null;
  for (const row of (baseline as never as Record<CareerTable, Array<{ kboId: string; name: string; values: Record<string, number> }>>)[table]) {
    const cur = currentById.get(row.kboId);
    const total = row.values[metric] + (cur ? Number(cur[spec.currentField]) : 0);
    if (!best || total > best.total) best = { name: row.name, total };
  }
  return best!;
}

function deps(): QaDeps {
  let stored: unknown = null; let started = false;
  return {
    loadGlossary: async () => [], loadPlayers: async () => [] as never,
    getCache: async () => null, setCache: async () => {},
    callLlm: async () => ({ text: JSON.stringify({ status: "OK", answer: "(generic LLM 답변)" }), inputTokens: 1, outputTokens: 1 }),
    reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; }, storeLlm: async (r: unknown) => { stored = r; },
    fetchSeasonRecord: async () => [] as never, enablePlayerRag: true, searchRag: async () => [],
    callRagLlm: async () => ({ text: "{}", inputTokens: 1, outputTokens: 1 }),
    fetchCareerMetricLeaderboard: fetcher, now: () => NOW.getTime(),
  } as unknown as QaDeps;
}

// ── 1. 스냅샷 무결성 ─────────────────────────────────────────────────────────
check("스냅샷: source·행수·sha256·지표 집합이 exact 계약과 일치한다", () => {
  const snap = baseline as never as {
    schemaVersion: number; throughSeason: number; sha256: string;
    source: { hitterUrl: string; pitcherUrl: string; seasonValue: string; currentSeason: number; capturedAt: string };
    metrics: Record<CareerTable, string[]>; rowCount: Record<CareerTable, number>;
    batter: unknown[]; pitcher: unknown[];
  };
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.throughSeason, 2025);
  assert.equal(snap.source.hitterUrl, "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx");
  assert.equal(snap.source.pitcherUrl, "https://www.koreabaseball.com/Record/Player/PitcherBasic/BasicTotal.aspx");
  assert.equal(snap.source.seasonValue, "9999");
  assert.equal(snap.source.currentSeason, 2026);
  assert.ok(Number.isFinite(Date.parse(snap.source.capturedAt)));
  for (const table of ["batter", "pitcher"] as const) {
    const catalogKeys = CAREER_METRICS_BY_TABLE[table].map((s) => s.key).sort();
    assert.deepEqual([...snap.metrics[table]].sort(), catalogKeys,
      `${table}: 스냅샷 지표와 카탈로그가 어긋났다 — 크롤러/서빙 SSOT 불일치`);
    assert.equal(snap.rowCount[table], snap[table].length, `${table}: 선언 행수와 실제 행수 불일치`);
  }
  const { sha256, ...unsigned } = snap;
  assert.equal(createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"), sha256);
});

check("당해 투수 스냅샷: canonical ID 전집합 exact coverage", () => {
  const rows = (pitchers as Array<Record<string, unknown>>).map((row) => ({ ...row }));
  const payload = { stats: rows, type: "pitcher", count: rows.length };
  assert.equal(rows.length, FULL_ENTRY_PITCHER_IDS.length);
  assert.equal(validateServedPitcherPayload(payload)?.length, rows.length);
  const missing = rows.filter((row) => String(row.kboId) !== String(rows[0].kboId));
  assert.equal(validateServedPitcherPayload({ ...payload, stats: missing, count: missing.length }), null,
    "리더 후보 1명 누락도 행수 하한으로 통과하면 안 된다");
  const duplicate = [...rows.slice(1), { ...rows[1] }];
  assert.equal(validateServedPitcherPayload({ ...payload, stats: duplicate }), null, "중복 ID");
  const unexpected = rows.map((row, i) => i === 0 ? { ...row, kboId: "99999" } : row);
  assert.equal(validateServedPitcherPayload({ ...payload, stats: unexpected }), null, "우주 밖 ID");
});

check("스냅샷: 모든 지표 값이 음이 아닌 정수다 (뺄셈 오염 검출)", () => {
  const snap = baseline as never as Record<CareerTable, Array<{ values: Record<string, number> }>>;
  for (const table of ["batter", "pitcher"] as const) {
    for (const row of snap[table]) {
      for (const spec of CAREER_METRICS_BY_TABLE[table]) {
        const v = row.values[spec.key];
        assert.ok(Number.isInteger(v) && v >= 0, `${table}.${spec.key}=${v}`);
      }
    }
  }
});

// ── 2. 질문 해석 (룰 증가 없음의 증거) ────────────────────────────────────────
check("intent: 카탈로그 전 지표가 `통산 <지표> 1위` 로 결속된다", () => {
  // ⚠️ 모호 판정 오라클은 **정확 일치 alias 충돌**이다. 처음에 substring 매처를 오라클로 썼다가
  //   `2루타`(=`루타` 를 포함)·`탈삼진`(=`삼진` 을 포함)을 모호로 오판했다 — 실제 resolver 는
  //   전체 문자열 앵커라 정확히 갈린다(실측: 2루타→doubles, 탈삼진→pitcher.so).
  //   **틀린 건 코드가 아니라 내 기대값이었다.** 오라클은 대상 로직과 독립이되 정확해야 한다.
  const owners = new Map<string, Set<string>>();
  for (const table of ["batter", "pitcher"] as const) {
    for (const spec of CAREER_METRICS_BY_TABLE[table]) {
      for (const alias of spec.aliases) {
        const key = alias.replace(/\s+/g, "");
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key)!.add(`${table}:${spec.key}`);
      }
    }
  }
  const missed: string[] = [];
  let bound = 0;
  for (const table of ["batter", "pitcher"] as const) {
    for (const spec of CAREER_METRICS_BY_TABLE[table]) {
      // 각 카탈로그 행은 alias 중 적어도 하나로 자기 자신에게 도달해야 한다. label 하나만 검사하면
      // 볼넷·사구·경기·삼진처럼 타자/투수 충돌 지표가 영구 미지원이어도 하한이 숨긴다.
      const reachable = spec.aliases.some((alias) => {
        const intent = resolveCareerMetricIntent(`통산 ${alias} 1위 누구야?`);
        return intent?.metric === spec.key && intent?.table === table;
      });
      if (!reachable) missed.push(`${table}.${spec.key}(${spec.label}): 도달 가능한 alias 0`);
      else bound += 1;
    }
  }
  assert.deepEqual(missed, [], `결속 실패: ${missed.join(", ")}`);
  const catalogSize = CAREER_METRICS_BY_TABLE.batter.length + CAREER_METRICS_BY_TABLE.pitcher.length;
  assert.equal(bound, catalogSize, `카탈로그 ${catalogSize}개 중 ${bound}개만 도달 가능`);
  console.log(`     결속 지표 ${bound}/${catalogSize} · 충돌 alias ${[...owners].filter(([, v]) => v.size > 1).length}개는 명시 alias로 해소`);
});

check("intent: 복수절·서술형은 결속하지 않는다 (#1159 4차 계약 유지)", () => {
  for (const q of [
    "통산 홈런 1위는 누구고 2위는 누구야?",
    "통산 홈런 1위는? 안타도 궁금해",
    "역대 최고의 타자는 누구야?",
    "통산이 뭐야?",
    "통산 삼진 1위 누구야?", // 타자 삼진 vs 투수 탈삼진 — 확정 불가
  ]) {
    assert.equal(resolveCareerMetricIntent(q), null, q);
  }
});

check("정규식 개수는 지표 수와 무관하다 (룰 누적 방지의 실측 앵커)", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/lib/baseball-qa/stats/career-metric-leaderboard.ts"), "utf-8");
  const count = (src.match(/new RegExp\(/g) ?? []).length;
  // 1위 형태 + 최다 형태, 두 개뿐이어야 한다. 지표가 늘어도 이 수는 그대로다.
  assert.equal(count, 2, `정규식이 ${count}개다 — 표현별 룰이 늘어나고 있다(설계 위반)`);
});

// ── 3. 값 정확성 ─────────────────────────────────────────────────────────────
check("값: 1위 선수·기록이 독립 재계산과 일치한다", () => {
  for (const [table, metric] of [
    ["batter", "hr"], ["batter", "hits"], ["batter", "rbi"], ["batter", "sb"], ["batter", "runs"],
    ["pitcher", "so"], ["pitcher", "wins"], ["pitcher", "saves"],
  ] as Array<[CareerTable, string]>) {
    const got = resolveCareerMetricLeaderboard(
      baseline, SERVED[table], SERVED_AT, { table, metric, from: 1, to: 1 }, NOW);
    assert.ok(got, `${table}.${metric}: null`);
    const want = expectedLeader(table, metric);
    assert.equal(got.rows[0].name, want.name, `${table}.${metric} 선수`);
    assert.equal(got.rows[0].total, want.total, `${table}.${metric} 기록`);
    assert.equal(got.rows[0].baseline + got.rows[0].current, got.rows[0].total, "기준선+증분 ≠ 합계");
  }
});

check("값: Top N 은 순위가 연속하고 내림차순이다", () => {
  const got = resolveCareerMetricLeaderboard(
    baseline, SERVED.batter, SERVED_AT, { table: "batter", metric: "hr", from: 1, to: 10 }, NOW);
  assert.ok(got);
  assert.equal(got.rows.length, 10);
  for (let i = 1; i < got.rows.length; i++) {
    assert.ok(got.rows[i - 1].total >= got.rows[i].total, `내림차순 위반 @${i}`);
    assert.ok(got.rows[i].rank >= got.rows[i - 1].rank, `순위 역행 @${i}`);
  }
  assert.equal(got.rows[0].rank, 1);
});

check("값: 순위 구간 상한 밖·역구간은 거절한다", () => {
  for (const q of [
    { from: 0, to: 1 }, { from: 2, to: 1 }, { from: 1, to: CAREER_RANK_MAX + 1 },
    { from: 1.5, to: 2 } as never,
  ]) {
    assert.equal(
      resolveCareerMetricLeaderboard(baseline, SERVED.batter, SERVED_AT,
        { table: "batter", metric: "hr", ...q }, NOW),
      null, JSON.stringify(q));
  }
});

// ── 4. fail-close ────────────────────────────────────────────────────────────
check("fail-close: 낡은/미래 스냅샷은 답하지 않는다", () => {
  const stale = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
  assert.equal(resolveCareerMetricLeaderboard(baseline, SERVED.batter, SERVED_AT,
    { table: "batter", metric: "hr", from: 1, to: 1 }, stale), null, "24h 초과");
  const future = "2026-08-13T12:00:00Z";
  assert.equal(resolveCareerMetricLeaderboard(baseline, SERVED.batter, future,
    { table: "batter", metric: "hr", from: 1, to: 1 }, NOW), null, "미래 시각");
});

check("fail-close: 서빙 행 오염(중복·타입·identity)은 답하지 않는다", () => {
  const base = SERVED.batter;
  const dup = [...base, { ...base[0] }];
  assert.equal(resolveCareerMetricLeaderboard(baseline, dup, SERVED_AT,
    { table: "batter", metric: "hr", from: 1, to: 1 }, NOW), null, "중복 kboId");
  const typed = base.map((r, i) => (i === 0 ? { ...r, hr: String(r.hr) } : r)) as SeasonRecordRow[];
  assert.equal(resolveCareerMetricLeaderboard(baseline, typed, SERVED_AT,
    { table: "batter", metric: "hr", from: 1, to: 1 }, NOW), null, "문자열 타입");
  const snap = baseline as never as { batter: Array<{ kboId: string; name: string }> };
  const target = snap.batter.find((b) => base.some((r) => String(r.kbo_id) === b.kboId))!;
  const renamed = base.map((r) => (String(r.kbo_id) === target.kboId ? { ...r, name: "다른선수" } : r));
  assert.equal(resolveCareerMetricLeaderboard(baseline, renamed, SERVED_AT,
    { table: "batter", metric: "hr", from: 1, to: 1 }, NOW), null, "identity 불일치");
});

check("fail-close: 스냅샷 manifest 절단·변조와 빈 서빙은 답하지 않는다", () => {
  assert.equal(resolveCareerMetricLeaderboard(baseline, [], SERVED_AT,
    { table: "batter", metric: "hr", from: 1, to: 1 }, NOW), null, "빈 서빙");
  assert.equal(resolveCareerMetricLeaderboard(baseline, SERVED.batter, SERVED_AT,
    { table: "batter", metric: "nope", from: 1, to: 1 }, NOW), null, "미등록 지표");
  const schemaBroken = { ...(baseline as object), schemaVersion: 2 };
  assert.equal(resolveCareerMetricLeaderboard(schemaBroken, SERVED.batter, SERVED_AT,
    { table: "batter", metric: "hr", from: 1, to: 1 }, NOW), null, "스키마 변경");

  // 절단자가 rowCount/hash까지 다시 써도 immutable manifest와 달라 거절돼야 한다.
  const truncated = JSON.parse(JSON.stringify(baseline)) as any;
  truncated.batter = truncated.batter.slice(0, 100);
  truncated.rowCount.batter = 100;
  delete truncated.sha256;
  truncated.sha256 = createHash("sha256").update(JSON.stringify(truncated)).digest("hex");
  assert.equal(resolveCareerMetricLeaderboard(truncated, SERVED.batter, SERVED_AT,
    { table: "batter", metric: "hr", from: 1, to: 1 }, NOW), null, "100행 self-consistent 절단본");

  const tampered = JSON.parse(JSON.stringify(baseline)) as any;
  tampered.batter[0].values.hr += 1; // stale sha256 유지
  assert.equal(resolveCareerMetricLeaderboard(tampered, SERVED.batter, SERVED_AT,
    { table: "batter", metric: "hr", from: 1, to: 1 }, NOW), null, "sha256 불일치 변조본");
});

// ── 5. 렌더 ──────────────────────────────────────────────────────────────────
check("fail-close: 오염된 스냅샷 값(음수·비정수·문자열)은 답하지 않는다", () => {
  // ⚠️ 종전 이 축은 **실제 스냅샷이 깨끗해서** 검증기가 사각이었다(mutation m9 GREEN).
  //   실 데이터가 정상이면 "검증을 지워도 통과"한다 — 오염 입력을 직접 만들어 태워야 게이트다.
  const clone = () => JSON.parse(JSON.stringify(baseline)) as any;
  for (const [label, poison] of [["음수", -1], ["소수", 1.5], ["문자열", "12"], ["null", null]] as Array<[string, unknown]>) {
    const broken = clone();
    broken.batter[0].values.hr = poison;
    delete broken.sha256;
    broken.sha256 = createHash("sha256").update(JSON.stringify(broken)).digest("hex");
    assert.equal(
      resolveCareerMetricLeaderboard(broken, SERVED.batter, SERVED_AT,
        { table: "batter", metric: "hr", from: 1, to: 1 }, NOW),
      null, `${label} 오염이 통과했다`);
  }
});

check("fail-close: 카탈로그엔 있으나 스냅샷에 없는 지표는 답하지 않는다", () => {
  // ⚠️ 종전 `metric:"nope"` 표본은 **앞단 spec 검사에 먼저 걸려** 스냅샷 검증을 태우지 못했다
  //   (mutation m11 GREEN — 이중 가드가 서로를 가려 검출력 0). 카탈로그에 **있는** 지표를
  //   스냅샷에서만 빼야 그 검증이 단독으로 시험된다.
  const broken = JSON.parse(JSON.stringify(baseline)) as any;
  broken.metrics.batter = broken.metrics.batter.filter((m: string) => m !== "hr");
  delete broken.sha256;
  broken.sha256 = createHash("sha256").update(JSON.stringify(broken)).digest("hex");
  assert.equal(
    resolveCareerMetricLeaderboard(broken, SERVED.batter, SERVED_AT,
      { table: "batter", metric: "hr", from: 1, to: 1 }, NOW),
    null, "스냅샷 미수집 지표를 답했다 — 기준선 없이 당해 값만 나간다");
});

check("intent: 접두 지표가 짧은 지표에 가로채이지 않는다 (alias 우선순위)", () => {
  // ⚠️ mutation m14 GREEN 이었던 축. `탈삼진` 은 `삼진` 을 포함하고, `2루타` 는 `루타` 를,
  //   `피안타` 는 `안타` 를 포함한다. 긴 alias 를 먼저 보지 않으면 짧은 쪽이 가로챈다.
  for (const [q, table, metric] of [
    ["통산 탈삼진 1위 누구야?", "pitcher", "so"],
    ["통산 2루타 1위 누구야?", "batter", "doubles"],
    ["통산 3루타 1위 누구야?", "batter", "triples"],
    ["통산 피안타 1위 누구야?", "pitcher", "h"],
    ["통산 피홈런 1위 누구야?", "pitcher", "hr"],
  ] as Array<[string, CareerTable, string]>) {
    const intent = resolveCareerMetricIntent(q);
    assert.equal(intent?.table, table, `${q} -> ${JSON.stringify(intent)}`);
    assert.equal(intent?.metric, metric, `${q} -> ${JSON.stringify(intent)}`);
  }
});

check("렌더: 단일 1위는 내역과 출처를 붙인다", () => {
  const got = resolveCareerMetricLeaderboard(baseline, SERVED.batter, SERVED_AT,
    { table: "batter", metric: "hr", from: 1, to: 1 }, NOW)!;
  const text = composeCareerMetricAnswer(got);
  const want = expectedLeader("batter", "hr");
  assert.ok(text.includes(want.name), "1위 선수명 없음");
  assert.ok(text.includes(want.total.toLocaleString("ko-KR")), "기록 없음");
  assert.ok(text.includes("2025년 말") && text.includes("2026시즌"), "내역 없음");
  assert.ok(text.includes("KBO 공식 기록실"), "출처 없음");
});

// ── 6. 종단 (production 증명) ────────────────────────────────────────────────
checkAsync("P0(종단): 지원 지표가 실제 값으로 답한다 (kbo_structured)", async () => {
  for (const [q, table, metric] of [
    ["통산 홈런 1위 누구야?", "batter", "hr"],
    ["통산 안타 1위 누구야?", "batter", "hits"],
    ["통산 타점 1위 누구야?", "batter", "rbi"],
    ["통산 도루 1위 누구야?", "batter", "sb"],
    ["통산 탈삼진 1위 누구야?", "pitcher", "so"],
    ["통산 세이브 1위 누구야?", "pitcher", "saves"],
    ["역대 최다 2루타 누구야?", "batter", "doubles"],
  ] as Array<[string, CareerTable, string]>) {
    const r = await answerQuestion("u1", q, deps());
    assert.equal(r.source, "kbo_structured", `${q} -> ${r.source} :: ${r.answer}`);
    const want = expectedLeader(table, metric);
    assert.ok(r.answer.includes(want.name), `${q}: 1위 선수(${want.name}) 미포함 :: ${r.answer}`);
    assert.ok(r.answer.includes(want.total.toLocaleString("ko-KR")), `${q}: 기록(${want.total}) 미포함`);
  }
});

checkAsync("P0(종단): 미지원·모호·서술형은 generic LLM 으로 새지 않는다", async () => {
  for (const q of [
    "통산 삼진 1위 누구야?",          // 모호
    "통산 OPS 1위 누구야?",           // 카탈로그 밖(rate)
    "통산 완봉승 1위 누구야?",         // 증분 미서빙이라 제외한 지표
    "통산 홈런 1위는 누구고 2위는 누구야?", // 복수절
  ]) {
    const r = await answerQuestion("u1", q, deps());
    assert.notEqual(r.source, "llm", `${q} 가 generic LLM 으로 샜다 :: ${r.answer}`);
    assert.notEqual(r.source, "kbo_structured", `${q} 가 값을 단정했다 :: ${r.answer}`);
  }
});

checkAsync("P0(종단): fetcher 미배선이면 hold — 추정값을 만들지 않는다", async () => {
  const noFetcher = { ...deps(), fetchCareerMetricLeaderboard: undefined } as QaDeps;
  const r = await answerQuestion("u1", "통산 홈런 1위 누구야?", noFetcher);
  assert.equal(r.source, "history_hold", `${r.source} :: ${r.answer}`);
});

checkAsync("P0(종단): 조회가 값을 못 찾으면 hold — 예외로 새지 않는다", async () => {
  // ⚠️ mutation m18 GREEN 이었던 축. fetcher 가 null(=확인 못 함)을 줄 때 그대로 흘리면
  //   렌더에서 터지거나 빈 답이 나간다. `history_hold` 로 명시 종결해야 한다.
  const nullFetcher = {
    ...deps(),
    fetchCareerMetricLeaderboard: async () => null,
  } as QaDeps;
  const r = await answerQuestion("u1", "통산 홈런 1위 누구야?", nullFetcher);
  assert.equal(r.source, "history_hold", `${r.source} :: ${r.answer}`);
  assert.ok(!/\d/.test(r.answer.replace(/2026/g, "")), `수치가 섞였다 :: ${r.answer}`);
});

checkAsync("무회귀: #1159 안타 실답 + #1164 순위확인형 차단", async () => {
  const hits = await answerQuestion("u1", "통산 안타 1위 누구야?", deps());
  assert.equal(hits.source, "kbo_structured", "#1159 회귀");
  // #1164: 선수를 지목한 순위 확인형은 개인값을 렌더하지 않는다.
  assert.equal(routeQuestion("최형우 통산 홈런 1위야?", [], [
    { kboId: "72443", name: "최형우", team: "삼성" },
  ] as never), "history_hold", "#1164 회귀");
});

async function main() {
  for (const [name, fn] of asyncChecks) {
    try { await fn(); pass += 1; console.log(`PASS ${name}`); }
    catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
  }
  console.log(`\ncareer metrics leaderboard: PASS=${pass} FAIL=${failures.length}`);
  if (failures.length > 0) { failures.forEach((f) => console.log(`  ${f}`)); process.exit(1); }
}
void main();
