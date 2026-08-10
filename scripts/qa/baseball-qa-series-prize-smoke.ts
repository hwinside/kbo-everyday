/**
 * 한국시리즈 MVP·우승 기여 질문 — KBO 공식 수상 정본 종단 계약 (2026-08-10 삼순 NO-GO 반영).
 *
 * fixture 는 `extract-kbo-series-prize-fixture.mjs` 가 실 페이지에서 **기계 추출**한
 * 것이다(#1137 지어낸 fixture 사고 재발 방지 — 손으로 쓰지 않는다).
 *
 * 고정하는 계약:
 *  1. 캡처 exact 2종이 정본 값(2025 = 김현수·LG·외야수)으로 답한다 — generic LLM 0회.
 *  2. 반대축: 재작년/2024 = 김선빈·KIA (연도 결정이 실제로 값을 바꾼다).
 *  3. 올해(2026) 미확정(`-`)은 지어내지 않고 "아직 정해지지 않았다"로 답한다.
 *  4. 비우승 전제(`작년 한화 우승…`)는 전제를 정정한다 — 침묵 승인 금지.
 *  5. 우승 기여 답변은 "기준에 따라 다름 + 시즌 전체는 스탯 기준" 을 밝힌다.
 *  6. 미배선 = hold fail-close (LLM 폴백 금지), 조회 실패 = error, 파싱 이상 = hold.
 *  7. 전 경로에서 RAG·cache 0회.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  answerQuestion,
  SYSTEM_ERROR_ANSWER,
  type QaDeps,
  type PlayerRef,
} from "../../src/lib/baseball-qa/pipeline";
import {
  parseSeriesPrize,
  resolveSeriesPrizeIntent,
  resolveSeriesPrizeYear,
} from "../../src/lib/baseball-qa/awards/series-prize";

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "kbo-series-prize.fixture.html"),
  "utf8",
);
const NOW = Date.UTC(2026, 7, 10); // 2026-08-10 — 캡처 시점 고정
const NOW_DATE = new Date(NOW);

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
}
const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function checkAsync(name: string, fn: () => Promise<void>) { asyncChecks.push({ name, fn }); }

// ── 1. 파서 — 기계 추출 fixture 실측 ─────────────────────────────────────────
check("파서: 정본 값 실측 (2025 김현수·2024 김선빈·2026 미확정)", () => {
  const rows = parseSeriesPrize(FIXTURE, NOW_DATE);
  assert.ok(rows, "파싱 실패");
  assert.deepEqual(rows.find((r) => r.year === 2025)?.koreanSeries, { name: "김현수", team: "LG", position: "외야수" });
  assert.deepEqual(rows.find((r) => r.year === 2024)?.koreanSeries, { name: "김선빈", team: "KIA", position: "내야수" });
  assert.equal(rows.find((r) => r.year === 2026)?.koreanSeries, null);
  assert.ok(rows.length >= 40, `연도 행 부족: ${rows.length}`);
});
check("파서 fail-close: 마커 부재·연도 이상·형식 파괴는 전체 거부", () => {
  assert.equal(parseSeriesPrize("<html>에러</html>", NOW_DATE), null);
  assert.equal(parseSeriesPrize(FIXTURE.replace(/올스타전/g, "다른섹션"), NOW_DATE), null);
  // 연도 하나를 원년 이전으로 오염 — 부분 신뢰 없이 전체 거부해야 한다.
  assert.equal(parseSeriesPrize(FIXTURE.replace(">2024<", ">1881<"), NOW_DATE), null);
  // 미래 연도 오염(최상단이라 내림차순은 유지됨) — 범위 검증만이 잡는다.
  assert.equal(parseSeriesPrize(FIXTURE.replace(">2026<", ">2999<"), NOW_DATE), null);
});
check("의도·연도 판정", () => {
  assert.equal(resolveSeriesPrizeIntent("작년 한국시리즈 MVP 누구야?"), "ks_mvp");
  assert.equal(resolveSeriesPrizeIntent("작년 LG우승에 가장 큰 기여를 한 사람은 누구야?"), "champion_contrib");
  assert.equal(resolveSeriesPrizeIntent("보크가 뭐야?"), null);
  assert.equal(resolveSeriesPrizeIntent("우승 상금이 얼마야?"), null, "기여 어휘 없는 우승 질문은 대상 아님");
  assert.equal(resolveSeriesPrizeYear("작년 한국시리즈 MVP 누구야?", NOW_DATE), 2025);
  assert.equal(resolveSeriesPrizeYear("재작년 한국시리즈 MVP는?", NOW_DATE), 2024);
  assert.equal(resolveSeriesPrizeYear("2019년 한국시리즈 MVP 누구야?", NOW_DATE), 2019);
  assert.equal(resolveSeriesPrizeYear("한국시리즈 MVP 누구야?", NOW_DATE), null);
});

// ── 2. 종단 (answerQuestion) — LLM·RAG·cache 0 ──────────────────────────────
interface Counters { llm: number; rag: number; cache: number; logs: string[] }
function makeDeps(fetchHtml: (() => Promise<string>) | undefined): { deps: QaDeps; c: Counters } {
  const c: Counters = { llm: 0, rag: 0, cache: 0, logs: [] };
  let stored: unknown = null;
  let started = false;
  const deps = {
    loadGlossary: async () => [],
    loadPlayers: async () => [] as PlayerRef[],
    getCache: async () => { c.cache++; return null; },
    setCache: async () => { c.cache++; },
    callLlm: async () => { c.llm++; return { text: '{"status":"UNSURE"}', inputTokens: 1, outputTokens: 1 }; },
    searchRag: async () => { c.rag++; return []; },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (row: { matchPath: string }) => { c.logs.push(row.matchPath); },
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (r: unknown) => { stored = r; },
    now: () => NOW,
    ...(fetchHtml ? { fetchSeriesPrizeHtml: fetchHtml } : {}),
  } as unknown as QaDeps;
  return { deps, c };
}
const fixtureFetcher = async () => FIXTURE;

checkAsync("캡처 exact ①: 작년 LG우승 기여 → 김현수 + 기준 명시, LLM 0", async () => {
  const { deps, c } = makeDeps(fixtureFetcher);
  const r = await answerQuestion("u1", "작년 LG우승에 가장 큰 기여를 한 사람은 누구야?", deps);
  assert.equal(r.source, "kbo_structured", r.answer);
  assert.ok(r.answer.includes("김현수"), r.answer);
  assert.ok(r.answer.includes("2025"), r.answer);
  assert.ok(r.answer.includes("기준에 따라 다를 수 있"), "기준 상대성 명시");
  assert.ok(r.answer.includes("스탯"), "시즌 전체 기여는 스탯 기준임을 밝힌다");
  assert.equal(c.llm, 0, "generic LLM 금지");
  assert.equal(c.rag, 0);
  assert.equal(c.cache, 0);
  assert.ok(c.logs.includes("kbo_structured"));
});
checkAsync("캡처 exact ②: 작년 한국시리즈 MVP → 김현수(LG, 외야수), LLM 0", async () => {
  const { deps, c } = makeDeps(fixtureFetcher);
  const r = await answerQuestion("u1", "작년 한국시리즈 MVP 누구야?", deps);
  assert.equal(r.source, "kbo_structured", r.answer);
  assert.ok(r.answer.includes("김현수"), r.answer);
  assert.ok(r.answer.includes("LG") && r.answer.includes("외야수"), r.answer);
  assert.equal(c.llm + c.rag + c.cache, 0);
});
checkAsync("반대축: 재작년 → 김선빈(KIA) — 연도 결정이 값을 바꾼다", async () => {
  const { deps } = makeDeps(fixtureFetcher);
  const r = await answerQuestion("u1", "재작년 한국시리즈 MVP는 누구였어?", deps);
  assert.ok(r.answer.includes("김선빈") && r.answer.includes("KIA"), r.answer);
  assert.ok(!r.answer.includes("김현수"), "다른 연도 값 혼입 금지");
});
checkAsync("올해(2026) 미확정 — 지어내지 않고 미정 안내", async () => {
  const { deps } = makeDeps(fixtureFetcher);
  const r = await answerQuestion("u1", "올해 한국시리즈 MVP 누구야?", deps);
  assert.ok(r.answer.includes("아직") && r.answer.includes("정해지지 않았"), r.answer);
  assert.ok(!/김현수|김선빈/.test(r.answer), "과거 수상자를 올해 답으로 내보내지 않는다");
});
checkAsync("비우승 전제 정정: 작년 한화 우승 → LG 였다고 바로잡는다", async () => {
  const { deps } = makeDeps(fixtureFetcher);
  const r = await answerQuestion("u1", "작년 한화 우승에 가장 큰 기여를 한 선수는 누구야?", deps);
  assert.ok(r.answer.includes("한화") && r.answer.includes("아니라"), `전제 정정 누락: ${r.answer}`);
  assert.ok(r.answer.includes("LG") && r.answer.includes("김현수"), r.answer);
});
checkAsync("시점어 없는 KS MVP 질문 → 가장 최근 확정 연도(2025)", async () => {
  const { deps } = makeDeps(fixtureFetcher);
  const r = await answerQuestion("u1", "한국시리즈 MVP가 누구야?", deps);
  assert.ok(r.answer.includes("2025") && r.answer.includes("김현수"), r.answer);
});
checkAsync("미배선 = hold fail-close, LLM 폴백 금지", async () => {
  const { deps, c } = makeDeps(undefined);
  const r = await answerQuestion("u1", "작년 한국시리즈 MVP 누구야?", deps);
  assert.equal(r.source, "history_hold", r.answer);
  assert.equal(c.llm, 0, "미배선에서 generic LLM 으로 새면 안 된다 — 그게 원래 사고다");
});
checkAsync("조회 실패 = error (기록 없음으로 둔갑 금지)", async () => {
  const { deps } = makeDeps(async () => { throw new Error("network"); });
  const r = await answerQuestion("u1", "작년 한국시리즈 MVP 누구야?", deps);
  assert.equal(r.source, "error");
  assert.equal(r.answer, SYSTEM_ERROR_ANSWER);
});
checkAsync("파싱 이상 = hold fail-close (오염 페이지로 답하지 않는다)", async () => {
  const { deps, c } = makeDeps(async () => "<html>점검 중</html>");
  const r = await answerQuestion("u1", "작년 한국시리즈 MVP 누구야?", deps);
  assert.equal(r.source, "history_hold", r.answer);
  assert.equal(c.llm, 0);
});
checkAsync("무회귀: 무관 질문은 이 경로를 타지 않는다", async () => {
  let fetches = 0;
  const { deps } = makeDeps(async () => { fetches++; return FIXTURE; });
  await answerQuestion("u1", "야구 경기는 얼마나 오래 해?", deps);
  assert.equal(fetches, 0, "무관 질문이 수상 정본을 조회하면 안 된다");
});

(async () => {
  for (const item of asyncChecks) {
    try { await item.fn(); pass += 1; console.log(`PASS ${item.name}`); }
    catch (e) { failures.push(item.name); console.log(`FAIL ${item.name} :: ${(e as Error).message}`); }
  }
  console.log(`\nbaseball QA series prize: PASS=*** FAIL=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
})();
