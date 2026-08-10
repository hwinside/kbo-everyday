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
  kstYear,
  parseSeriesPrize,
  renderSeriesPrizeAnswer,
  resolvePrizeTeamMention,
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
  // 양성 결속 반대축 (삼순 3차 P0 — denylist 금지): 허용 모양은 (a) KS 직접 지목,
  // (b) 구단+무한정 우승뿐. 다른 대회 문맥이 보이면 (a)(b) 여도 물러난다.
  assert.equal(resolveSeriesPrizeIntent("작년 준우승에 가장 기여한 선수는 누구야?"), null, "준우승은 우승이 아니다");
  assert.equal(resolveSeriesPrizeIntent("작년 정규시즌 우승에 기여한 선수 누구야?"), null, "정규시즌 우승은 KS MVP 와 무관");
  assert.equal(resolveSeriesPrizeIntent("작년 페넌트레이스 우승 주역은 누구야?"), null);
  assert.equal(resolveSeriesPrizeIntent("작년 아시안게임 우승 주역 선수는 누구야?"), null, "타 대회 우승");
  // 구단·KS 가 섞여 있어도 타 대회 문맥이 보이면 물러난다 — 양성 결속만으로는 이 모양을
  // 못 막으므로 OTHER_COMPETITION 차단선이 단독으로 load-bearing 이다.
  assert.equal(resolveSeriesPrizeIntent("작년 기아 아시안게임 우승 주역 누구야?"), null, "구단+타 대회");
  assert.equal(resolveSeriesPrizeIntent("작년 LG 준우승에 기여한 선수 누구야?"), null, "구단+준우승");
  assert.equal(resolveSeriesPrizeIntent("작년 삼성 정규시즌 우승 주역은 누구?"), null, "구단+정규시즌");
  assert.equal(resolveSeriesPrizeIntent("작년 국가대표 우승에 기여한 선수 누구?"), null, "국가대표 문맥");
  assert.equal(resolveSeriesPrizeIntent("플레이오프 우승 주역 누구야?"), null, "PO");
  assert.equal(resolveSeriesPrizeIntent("와일드카드 우승 기여 선수?"), null, "WC");
  assert.equal(resolveSeriesPrizeIntent("작년 우승 주역이 누구야?"), null, "구단 미지목 무한정 우승은 proxy 밖 — 기존 경로로");
  assert.equal(resolveSeriesPrizeIntent("작년 LG 한국시리즈 우승 주역 누구야?"), "champion_contrib", "(a) KS 직접 지목");
  assert.equal(resolveSeriesPrizeIntent("작년 LG우승에 가장 큰 기여를 한 사람은 누구야?"), "champion_contrib", "(b) 구단+무한정 우승 (원 사고 형태)");
  assert.deepEqual(resolveSeriesPrizeYear("작년 한국시리즈 MVP 누구야?", NOW_DATE), { kind: "year", year: 2025 });
  assert.deepEqual(resolveSeriesPrizeYear("재작년 한국시리즈 MVP는?", NOW_DATE), { kind: "year", year: 2024 });
  assert.deepEqual(resolveSeriesPrizeYear("2019년 한국시리즈 MVP 누구야?", NOW_DATE), { kind: "year", year: 2019 });
  assert.deepEqual(resolveSeriesPrizeYear("올해 한국시리즈 MVP는?", NOW_DATE), { kind: "year", year: 2026 });
  assert.deepEqual(resolveSeriesPrizeYear("한국시리즈 MVP 누구야?", NOW_DATE), { kind: "latest" });
  // 복수·범위·역대 (삼순 4차 P0): 첫 값 단일답 축소 금지 — 전부 ambiguous fail-close.
  for (const q of [
    "2024년과 2025년 한국시리즈 MVP 알려줘",
    "작년과 올해 한국시리즈 MVP 누구야?",
    "역대 한국시리즈 MVP 알려줘",
    "2019년 이후 한국시리즈 MVP 전부 알려줘",
    "최근 5년 한국시리즈 MVP",
    "연도별 한국시리즈 MVP",
  ]) {
    assert.deepEqual(resolveSeriesPrizeYear(q, NOW_DATE), { kind: "ambiguous" }, q);
  }
  // KST 자정 경계 (삼순 P1): KST 2027-01-01 00:30 = UTC 2026-12-31 15:30. UTC 연도로
  // 계산하면 `작년`=2025 로 1년 어긋난다 — KST 기준 2026 이어야 한다.
  const boundary = new Date(Date.UTC(2026, 11, 31, 15, 30));
  assert.equal(kstYear(boundary), 2027);
  assert.deepEqual(resolveSeriesPrizeYear("작년 한국시리즈 MVP 누구야?", boundary), { kind: "year", year: 2026 });
});
check("붙여쓰기 팀 해석 — 수상표 표기 결속 폐쇄 alias (삼순 P1 원 사고 형태)", () => {
  assert.equal(resolvePrizeTeamMention("작년 한화우승에 기여한 선수는?"), "한화");
  assert.equal(resolvePrizeTeamMention("작년 LG우승에 가장 큰 기여를 한 사람은?"), "LG");
  assert.equal(resolvePrizeTeamMention("작년 엘지 우승 주역"), "LG");
  // 복수 구단이 걸리면 전제 판정 불가 — 틀린 정정 금지.
  assert.equal(resolvePrizeTeamMention("LG와 한화 중 어디가 우승했어?"), null);
  assert.equal(resolvePrizeTeamMention("작년 우승 주역"), null);
});
check("역사 결측 분리 — 1985 미개최 ≠ 올해 미확정 (삼순 P1)", () => {
  const rows = parseSeriesPrize(FIXTURE, NOW_DATE);
  assert.ok(rows);
  assert.equal(rows.find((r) => r.year === 1985)?.koreanSeries, null, "fixture 실측: 1985 는 `-` 행");
  const past = renderSeriesPrizeAnswer(rows, "ks_mvp", 1985, null, kstYear(NOW_DATE));
  assert.ok(past.answer.includes("열리지 않아"), past.answer);
  assert.ok(!past.answer.includes("시즌이 끝나면"), "과거 미개최에 미래형 안내는 오안내");
  const current = renderSeriesPrizeAnswer(rows, "ks_mvp", 2026, null, kstYear(NOW_DATE));
  assert.ok(current.answer.includes("아직") && current.answer.includes("시즌이 끝나면"), current.answer);
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
checkAsync("붙여쓰기 `한화우승` 도 전제 정정된다 (원 사고 형태, 삼순 P1)", async () => {
  const { deps } = makeDeps(fixtureFetcher);
  const r = await answerQuestion("u1", "작년 한화우승에 가장 큰 기여를 한 선수는 누구야?", deps);
  assert.ok(r.answer.includes("한화") && r.answer.includes("아니라"), `붙여쓰기 전제 정정 누락: ${r.answer}`);
  assert.ok(r.answer.includes("김현수"), r.answer);
});
checkAsync("협착 종단: 준우승·정규시즌·아시안게임·국대 질문은 KS MVP 로 답하지 않는다 (삼순 P0)", async () => {
  for (const q of [
    "작년 준우승에 가장 기여한 선수는 누구야?",
    "작년 정규시즌 우승에 기여한 선수 누구야?",
    "작년 아시안게임 우승 주역 선수는 누구야?",
    "작년 국가대표 우승에 기여한 선수 누구?",
  ]) {
    let fetches = 0;
    const { deps } = makeDeps(async () => { fetches++; return FIXTURE; });
    const r = await answerQuestion("u1", q, deps);
    assert.equal(fetches, 0, `${q} — 수상 정본을 조회하면 안 된다`);
    assert.ok(!r.answer.includes("김현수"), `${q} — KS MVP 로 바꿔 답하면 안 된다: ${r.answer}`);
  }
});
checkAsync("복수·범위·역대 종단: 정본 조회 0회 + 단일답 축소 금지 (삼순 4차 P0)", async () => {
  for (const q of [
    "2024년과 2025년 한국시리즈 MVP 알려줘",
    "작년과 올해 한국시리즈 MVP 누구야?",
    "역대 한국시리즈 MVP 알려줘",
    "2019년 이후 한국시리즈 MVP 전부 알려줘",
    "최근 5년 한국시리즈 MVP",
  ]) {
    let fetches = 0;
    const { deps, c } = makeDeps(async () => { fetches++; return FIXTURE; });
    const r = await answerQuestion("u1", q, deps);
    assert.equal(fetches, 0, `${q} — 수상 정본을 조회하면 안 된다`);
    assert.equal(c.llm, 0, `${q} — LLM 0`);
    assert.ok(!r.answer.includes("김현수") && !r.answer.includes("김선빈"), `${q} — 단일답 축소 금지: ${r.answer}`);
  }
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
