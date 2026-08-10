/**
 * 야잘알봇 연도별·통산·과거 시즌 기록(career-series) 회귀.
 *
 * 배경 (2026-08-10 하린아빠 캡처): `최형우의 연도별 타율 추이가 어떻게 돼?` 가
 * 올해 단일값(.321) 반복으로 오답 — 시리즈·통산·과거 의도가 감지되지 않아
 * "올해 단일값" 경로가 선점했다. 종전 계약은 통산·작년을 "준비 중" fail-close 로
 * 닫았는데, 정본(KBO 공식 Total.aspx 연도별 테이블)을 안 보고 있었을 뿐이다.
 *
 * 고정하는 계약:
 *  1. fixture 는 **기계 추출**만 쓴다 (`extract-kbo-career-fixture.mjs`) — 지어낸
 *     fixture 는 실측이 아니다 (2026-08-09 #1137 사고).
 *  2. 파서는 어떤 이상(신원 마커 부재·헤더 변형·연도 범위 밖·순서 붕괴·값 형식
 *     불량·칸 수 불일치)에도 null — 부분 성공을 돌려주지 않는다.
 *  3. 시리즈는 전 연도 + 통산까지 충분히 길게, 통산·특정 연도는 단답 —
 *     하린아빠 2026-08-10 "단답형은 단답형으로, 긴 답변이 필요한 경우는 충분히 길게".
 *  4. 파이프라인: career 의도는 kbo_structured 로 종결, 미배선·identity 불일치·
 *     컬럼 결측은 전부 blocked fail-close. LLM·RAG·cache 를 태우지 않는다.
 *  5. 기존 경로 무회귀 — 올해 단일값·untrusted·미래 연도 fail-close 그대로.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCareerTotalsHtml,
  createCareerRecordFetcher,
  careerTotalsUrl,
  composeCareerSeriesAnswer,
  composeCareerTotalAnswer,
  composeCareerYearAnswer,
  CAREER_METRIC_COLUMNS,
} from "../../src/lib/baseball-qa/stats/career-series";
import { resolveSeasonRecordIntent } from "../../src/lib/baseball-qa/stats/season-record";
import {
  answerQuestion,
  type QaDeps,
  type GlossaryEntry,
  type PlayerRef,
} from "../../src/lib/baseball-qa/pipeline";

const here = dirname(fileURLToPath(import.meta.url));
const BATTER_HTML = readFileSync(join(here, "fixtures", "kbo-career-batter.html"), "utf-8");
const PITCHER_HTML = readFileSync(join(here, "fixtures", "kbo-career-pitcher.html"), "utf-8");
const SEASON = 2026;

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
}
const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function checkAsync(name: string, fn: () => Promise<void>) { asyncChecks.push({ name, fn }); }

// ── 1. 파서 — 기계 추출 fixture (실존: 최형우 72443 / 임찬규 61101) ────────────
check("full-origin 데뷔 한정 = 통산 동치 (삼순 5차: 현재시즌 축소 금지)", () => {
  for (const q of ["최형우 데뷔 이래 홈런 몇 개야?", "최형우 데뷔 후 홈런 몇 개 쳤어?", "최형우 입단 이후 안타 몇 개야?"]) {
    const intent = resolveSeasonRecordIntent(q, "batter");
    assert.equal(intent.kind, "career", `${q} → ${intent.kind}`);
    assert.equal((intent as { span: { type: string } }).span.type, "career", q);
  }
});
check("타자 fixture: 최형우 시리즈+통산이 그대로 읽힌다", () => {
  const rec = parseCareerTotalsHtml(BATTER_HTML, SEASON);
  assert.ok(rec, "파싱 실패");
  assert.equal(rec.playerName, "최형우");
  assert.ok(rec.rows.length >= 20, `연도 행이 너무 적다: ${rec.rows.length}`);
  assert.equal(rec.rows[0].year, 2002);
  assert.equal(rec.rows[0].team, "삼성");
  assert.equal(rec.rows[0].values.AVG, "0.400");
  const last = rec.rows[rec.rows.length - 1];
  assert.equal(last.year, SEASON);
  assert.equal(last.team, "삼성");
  assert.ok(rec.career, "통산 행 없음");
  assert.match(rec.career.AVG, /^\d\.\d{3}$/);
});

check("투수 fixture: 임찬규 ERA 시리즈+통산", () => {
  const rec = parseCareerTotalsHtml(PITCHER_HTML, SEASON);
  assert.ok(rec, "파싱 실패");
  assert.equal(rec.playerName, "임찬규");
  assert.equal(rec.rows[0].year, 2011);
  assert.equal(rec.rows[0].team, "LG");
  assert.match(rec.rows[0].values.ERA, /^\d+\.\d{2}$/);
  assert.ok(rec.career?.ERA, "통산 ERA 없음");
});

// ── 2. 파서 fail-close (결함주입 — 각 축이 실제로 RED 를 만든다) ───────────────
check("신원 마커가 없으면 null", () => {
  assert.equal(parseCareerTotalsHtml(BATTER_HTML.replace(/lblName/g, "lblGone"), SEASON), null);
});
check("헤더가 연도/팀명으로 시작하지 않으면 null", () => {
  assert.equal(parseCareerTotalsHtml(BATTER_HTML.replace(">연도<", ">순위<"), SEASON), null);
});
check("미래 연도 행이 있으면 null (전체 거부 — 부분 신뢰 금지)", () => {
  assert.equal(parseCareerTotalsHtml(BATTER_HTML.replace(">2002<", ">2050<"), SEASON), null);
  // ⚠️ 마지막 행을 미래로 — 오름차순은 유지되므로 **범위 검증만이** 잡는다
  // (순서 검증에 가려져 mutation m3 가 MISS 되던 검출력 결손을 메운다).
  assert.equal(parseCareerTotalsHtml(BATTER_HTML.replace(`>${SEASON}<`, ">2099<"), SEASON), null);
});
check("연도 순서가 붕괴하면 null", () => {
  // 2004 를 2003 이전 값으로 바꿔 오름차순을 깬다 (2002 다음에 1999).
  assert.equal(parseCareerTotalsHtml(BATTER_HTML.replace(">2004<", ">1999<"), SEASON), null);
});
check("값 형식이 불량하면 null", () => {
  assert.equal(parseCareerTotalsHtml(BATTER_HTML.replace(">0.400<", ">사백<"), SEASON), null);
});

// ── 3. 렌더 계약 ──────────────────────────────────────────────────────────────
const BATTER_REC = parseCareerTotalsHtml(BATTER_HTML, SEASON)!;
check("시리즈 렌더 — 전 연도 + 통산을 충분히 길게", () => {
  const answer = composeCareerSeriesAnswer("최형우", "타율", "AVG", BATTER_REC);
  assert.ok(answer);
  for (const row of BATTER_REC.rows) {
    assert.ok(answer.includes(`${row.year} ${row.team} ${row.values.AVG}`), `${row.year} 행 누락`);
  }
  assert.ok(answer.includes(`통산 ${BATTER_REC.career!.AVG}`), "통산 누락");
  assert.ok(answer.includes("KBO 공식 기록"), "출처 표기 누락");
});
check("통산 렌더 — 단답", () => {
  const answer = composeCareerTotalAnswer("최형우", "타율", "AVG", BATTER_REC)!;
  assert.ok(answer.includes(`통산 타율`) && answer.includes(BATTER_REC.career!.AVG));
  assert.ok(answer.split("\n").length === 1, "통산은 단답이어야 한다");
});
check("특정 연도 렌더 — 그 해 팀 소속까지", () => {
  const answer = composeCareerYearAnswer("최형우", "타율", "AVG", 2025, BATTER_REC)!;
  assert.ok(answer.includes("2025") && answer.includes("KIA"), `2025 KIA 표기: ${answer}`);
});
check("없는 연도·없는 컬럼은 null (지어내지 않는다)", () => {
  assert.equal(composeCareerYearAnswer("최형우", "타율", "AVG", 2003, BATTER_REC), null);
  assert.equal(composeCareerSeriesAnswer("최형우", "OPS", "OPS", BATTER_REC), null);
});

// ── 4. 의도 판정 ──────────────────────────────────────────────────────────────
check("연도별·추이 → career series (캡처 exact 2건)", () => {
  for (const q of [
    "최형우의 연도별 타율 추이가 어떻게 돼?",
    "최형우의 데뷔시점부터 현재까지 연도별 타율이 각각 어떻게 돼?",
  ]) {
    const intent = resolveSeasonRecordIntent(q);
    assert.equal(intent.kind, "career", q);
    assert.deepEqual((intent as { span: unknown }).span, { type: "series" }, q);
  }
});
check("통산·커리어 → career total (종전 '준비 중' fail-close 해제)", () => {
  const intent = resolveSeasonRecordIntent("최형우 통산 타율 얼마야?");
  assert.equal(intent.kind, "career");
  assert.deepEqual((intent as { span: unknown }).span, { type: "career" });
});
check("작년·재작년·명시 연도 → career year", () => {
  const cases: Array<[string, number]> = [
    ["최형우 작년 타율", SEASON - 1],
    ["최형우 재작년 홈런 몇 개", SEASON - 2],
    ["최형우 2020년 타율", 2020],
  ];
  for (const [q, year] of cases) {
    const intent = resolveSeasonRecordIntent(q);
    assert.equal(intent.kind, "career", q);
    assert.deepEqual((intent as { span: unknown }).span, { type: "year", year }, q);
  }
});
check("무회귀: 올해 단일값·미래 연도·untrusted 는 종전 그대로", () => {
  assert.equal(resolveSeasonRecordIntent("최형우 타율 얼마야?").kind, "query");
  assert.equal(resolveSeasonRecordIntent("최형우 올해 타율").kind, "query");
  assert.equal(resolveSeasonRecordIntent("최형우 2030년 타율").kind, "unsupported_season");
  assert.equal(resolveSeasonRecordIntent("최형우 작년 타석 몇 번").kind, "untrusted_metric");
  // 서술형은 여전히 기록 경로 대상이 아니다.
  assert.equal(resolveSeasonRecordIntent("최형우 작년에 잘 쳤어?").kind, "none");
});
check("연도 2개 이상 명시는 fail-close (범위 질의는 지원 안 함)", () => {
  assert.equal(resolveSeasonRecordIntent("최형우 2019년이랑 2020년 타율").kind, "unsupported_season");
});

// ── 4-b. 시점 참조 전수 추출 → 복수/범위면 fail-close (삼순 2026-08-10 2차 NO-GO) ──
// exact 정규식 덧대기가 아니라 scanTemporalRefs 가 구조로 강제한다 — 동치 표현이 같이 닫힌다.
check("범위·최근 N 한정은 단위 무관 fail-close (축 ① + 2차 반대축)", () => {
  // bare `추이` 가 먼저 잡으면 `최근 N` 이 전 커리어로 바뀝다 — 축소 오답.
  assert.equal(resolveSeasonRecordIntent("최형우 최근 10경기 타율 추이 알려줘").kind, "unsupported_season");
  // 2차 반대축: 단위가 `년/시즌` 이어도 막힌다 (종전 단위 열거의 구멍).
  assert.equal(resolveSeasonRecordIntent("최형우 최근 3년 타율 추이").kind, "unsupported_season");
  assert.equal(resolveSeasonRecordIntent("최형우 2019~2020 연도별 타율").kind, "unsupported_season");
  // 범위 표지(이후·부터)가 연도에 붙으면 구간 질의다.
  assert.equal(resolveSeasonRecordIntent("최형우 2019년 이후 타율 추이").kind, "unsupported_season");
  assert.equal(resolveSeasonRecordIntent("최형우 2019년부터 타율").kind, "unsupported_season");
});
check("상대연도끼리·상대+현재 복수 참조도 fail-close (2차 반대축 — 숨은 단일값 축소 금지)", () => {
  // 종전엔 숫자 연도만 복수 판정 → `작년과 올해` 가 작년 단일값으로 축소됐다.
  assert.equal(resolveSeasonRecordIntent("최형우 작년과 올해 타율 비교해줘").kind, "unsupported_season");
  // `재작년`⊃`작년` 부분열 — 긴 토큰 선소거로 2개로 센다.
  assert.equal(resolveSeasonRecordIntent("최형우 작년과 재작년 타율 비교").kind, "unsupported_season");
});
check("cutoff는 상대연도에도 결속된다 (2차 반대축 — `작년까지`가 작년 단일값으로 축소 금지)", () => {
  assert.equal(resolveSeasonRecordIntent("최형우 작년까지 홈런 몇 개").kind, "unsupported_season");
  // 단일 시점 + 시리즈어 모순 조합도 축소하지 않는다.
  assert.equal(resolveSeasonRecordIntent("최형우 작년 타율 추이").kind, "unsupported_season");
});
check("최고/커리어하이·cutoff 는 통산으로 축소하지 않는다 (축 ②)", () => {
  // 통산 = 전 기간 **평균/누계**다. 극값(최고 타율)은 다른 값이며 정본 조회가 아니다.
  assert.equal(resolveSeasonRecordIntent("최형우 역대 최고 타율이 몇이야?").kind, "unsupported_season");
  assert.equal(resolveSeasonRecordIntent("최형우 커리어하이 타율은?").kind, "unsupported_season");
  // cutoff 부분합은 현재 통산 행(올해 포함)과 다른 값이다.
  assert.equal(resolveSeasonRecordIntent("최형우 2025년까지 통산 홈런").kind, "unsupported_season");
  assert.equal(resolveSeasonRecordIntent("최형우 작년까지 통산 안타").kind, "unsupported_season");
});
check("올해 포함 복수 연도 비교도 fail-close — 2026 선제거 둘감 금지 (축 ③)", () => {
  // 종전에는 filter 가 2026을 먼저 지워 `2025+2026 비교` 가 2025 단일값으로 둘갓했다.
  assert.equal(resolveSeasonRecordIntent("최형우 2025년과 2026년 타율 비교해줘").kind, "unsupported_season");
  assert.equal(resolveSeasonRecordIntent("최형우 2026년이랑 2025년 홈런 비교").kind, "unsupported_season");
});
check("무회귀: 정상 시리즈·통산·단일 연도는 그대로 답한다", () => {
  assert.equal(resolveSeasonRecordIntent("최형우 연도별 타율 추이 알려줘").kind, "career");
  assert.equal(resolveSeasonRecordIntent("최형우 통산 타율 얼마야?").kind, "career");
  assert.equal(resolveSeasonRecordIntent("최형우 2019년 홈런 몇 개야?").kind, "career");
});

// ── 5. fetcher seam — 게이트가 실제 배포 함수를 실행한다 ─────────────────────
checkAsync("factory: fixture HTML 주입 → 같은 파서 경로로 파싱", async () => {
  const urls: string[] = [];
  const fetcher = createCareerRecordFetcher(async (url) => { urls.push(url); return BATTER_HTML; }, () => Date.UTC(SEASON, 7, 10));
  const rec = await fetcher("batter", "72443");
  assert.equal(rec?.playerName, "최형우");
  assert.equal(urls[0], careerTotalsUrl("batter", "72443"));
  assert.ok(urls[0].includes("HitterDetail"));
});
checkAsync("factory: kboId 비숫자는 fetch 자체를 막는다 (URL 주입 방지)", async () => {
  let called = false;
  const fetcher = createCareerRecordFetcher(async () => { called = true; return BATTER_HTML; });
  assert.equal(await fetcher("batter", "72443; DROP"), null);
  assert.equal(called, false);
});

// ── 6. 파이프라인 배선 ────────────────────────────────────────────────────────
const GLOSSARY: GlossaryEntry[] = [];
const PLAYERS = [
  { kboId: "72443", name: "최형우", team: "삼성", position: "외야수" },
] as unknown as PlayerRef[];

function makeDeps(overrides: Partial<QaDeps> = {}): { deps: QaDeps; logs: string[] } {
  const logs: string[] = [];
  let stored: unknown = null;
  let started = false;
  const deps = {
    loadGlossary: async () => GLOSSARY,
    loadPlayers: async () => PLAYERS,
    getCache: async () => null,
    setCache: async () => {},
    callLlm: async () => ({ text: JSON.stringify({ status: "NOT_BASEBALL" }), inputTokens: 1, outputTokens: 1 }),
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (row: { matchPath: string }) => { logs.push(row.matchPath); },
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (r: unknown) => { stored = r; },
    fetchSeasonRecord: async () => [],
    // Production 과 같은 스위치 상태 — 선수 기록 경로는 enablePlayerRag 안쪽에 있다
    // (꺼지면 routeQuestion 이 history_hold 로 선점해 기록 경로가 아예 안 돈다).
    enablePlayerRag: true,
    searchRag: async () => [],
    callRagLlm: async () => ({ text: "{}", inputTokens: 1, outputTokens: 1 }),
    ...overrides,
  } as unknown as QaDeps;
  return { deps, logs };
}

checkAsync("파이프라인: 연도별 시리즈 → kbo_structured 전 연도 실답 (캡처 exact)", async () => {
  const fetcher = createCareerRecordFetcher(async () => BATTER_HTML, () => Date.UTC(SEASON, 7, 10));
  const { deps } = makeDeps({ fetchCareerRecord: fetcher });
  const result = await answerQuestion("u1", "최형우의 연도별 타율 추이가 어떻게 돼?", deps);
  assert.equal(result.source, "kbo_structured", result.answer);
  assert.ok(result.answer.includes("2002 삼성 0.400"), result.answer.slice(0, 200));
  assert.ok(result.answer.includes("통산"), "통산 누락");
});
checkAsync("파이프라인: 통산 단답 + 작년 단답", async () => {
  const fetcher = createCareerRecordFetcher(async () => BATTER_HTML, () => Date.UTC(SEASON, 7, 10));
  const { deps } = makeDeps({ fetchCareerRecord: fetcher });
  const total = await answerQuestion("u1", "최형우 통산 타율 얼마야?", deps);
  assert.equal(total.source, "kbo_structured");
  assert.ok(total.answer.includes("통산 타율"));
  const year = await answerQuestion("u1", "최형우 작년 타율 얼마였어?", deps);
  assert.equal(year.source, "kbo_structured");
  assert.ok(year.answer.includes("2025") && year.answer.includes("KIA"), year.answer);
});
checkAsync("파이프라인: 미배선이면 blocked fail-close (숫자 지어내지 않음)", async () => {
  const { deps, logs } = makeDeps(); // fetchCareerRecord 없음
  const result = await answerQuestion("u1", "최형우 통산 타율 얼마야?", deps);
  assert.equal(result.source, "blocked");
  assert.ok(logs.includes("blocked"));
});
checkAsync("파이프라인: identity 불일치는 blocked (다른 선수 기록 서빙 금지)", async () => {
  const wrongName = BATTER_HTML.replace(">최형우<", ">박형우<");
  const fetcher = createCareerRecordFetcher(async () => wrongName, () => Date.UTC(SEASON, 7, 10));
  const { deps } = makeDeps({ fetchCareerRecord: fetcher });
  const result = await answerQuestion("u1", "최형우 통산 타율 얼마야?", deps);
  assert.equal(result.source, "blocked");
});
checkAsync("파이프라인: 동치 축소형 전부 blocked 종단 — fetch/LLM/RAG/cache 0 (삼순 3차 table-driven)", async () => {
  // intent 단정만으로는 파이프라인이 이 판정을 쓰는지 보장되지 않는다 — answerQuestion
  // 종단에서 blocked + 모든 데이터 경로 0회를 table-driven 으로 고정한다.
  const equivalents = [
    "최형우 최근 3년 타율 추이 알려줘",
    "최형우 2019년 이후 타율 추이",
    "최형우 작년과 올해 타율 비교해줘",
    "최형우 작년과 재작년 타율 비교",
    "최형우 작년까지 홈런 몇 개야",
    "최형우 작년과 현재 타율 비교해줘",
    "최형우 작년보다 지금 타율이 좋아?",
    // bounded 데뷔 범위 (삼순 4차 P0): full-career 동치가 아니다 — 전 커리어 시리즈로
    // 축소되면 안 되고 blocked + 전 호출 0 이어야 한다.
    "최형우 데뷔 후 3년 타율 추이",
    "최형우 데뷔 후 첫 3년 타율 추이",
    "최형우 입단 첫 3시즌 홈런 추이",
    "최형우 데뷔 이후 3년 홈런 추이",
    // 단일 데뷔 시즌·bare 데뷔 언급 (삼순 5차): 현재시즌으로도 전 커리어로도 축소 금지.
    "최형우 데뷔 시즌 홈런 몇 개야?",
    "최형우 입단 첫해 타율 알려줘",
    "최형우 데뷔 홈런 기록 알려줘",
    // 연결어 `후/이후` + single 마커 (삼순 6차): full-origin 보다 먼저 닫혀야 한다 —
    // `입단 후 첫해` 가 career total 로 축소되면 오답이다.
    "최형우 입단 후 첫해 타율 알려줘",
    "최형우 데뷔 후 첫 시즌 홈런 몇 개야?",
    "최형우 데뷔 이후 첫 시즌 타율",
    "최형우 데뷔 첫 경기 안타 몇 개야?",
    // 서수 동치 (삼순 7차): `첫 번째 시즌/해` 는 `첫 시즌/해` 와 같은 single 데뷔시즌
    // 질의 — `번째` 가 끼어도 full-origin(통산) 으로 축소되면 안 된다.
    "최형우 데뷔 후 첫 번째 시즌 홈런 몇 개야?",
    "최형우 데뷔 이후 첫 번째 해 타율",
    "최형우 입단 후 첫번째 해 타율",
    "최형우 데뷔 후 첫 년도 타율",
    // 첫째 이외 단일 서수 (삼순 8차): 두 번째·둘째·N번째도 특정 한 시즌 selector 다.
    // 어느 마커에도 안 걸리고 full-origin(`데뷔후`)이 선점해 통산으로 축소되면 안 된다.
    "최형우 데뷔 후 두 번째 시즌 홈런 몇 개야?",
    "최형우 입단 후 둘째 해 타율",
    "최형우 데뷔 후 2번째 시즌 홈런",
  ];
  for (const q of equivalents) {
    let careerFetches = 0;
    let llmCalls = 0;
    let ragSearches = 0;
    let cacheReads = 0;
    let cacheWrites = 0;
    const { deps } = makeDeps({
      fetchCareerRecord: (async () => { careerFetches++; return []; }) as never,
      fetchSeasonRecord: (async () => { careerFetches++; return []; }) as never,
      callLlm: async () => { llmCalls++; return { text: "{}", inputTokens: 1, outputTokens: 1 }; },
      callRagLlm: async () => { llmCalls++; return { text: "{}", inputTokens: 1, outputTokens: 1 }; },
      searchRag: async () => { ragSearches++; return [] as never; },
      getCache: async () => { cacheReads++; return null; },
      setCache: async () => { cacheWrites++; },
    });
    const result = await answerQuestion("u1", q, deps);
    assert.equal(result.source, "blocked", `${q}: 축소 답 대신 blocked 여야 한다 — ${result.answer}`);
    assert.equal(careerFetches, 0, `${q}: 기록 fetch 0`);
    assert.equal(llmCalls, 0, `${q}: LLM 0`);
    assert.equal(ragSearches, 0, `${q}: RAG 0`);
    assert.equal(cacheReads + cacheWrites, 0, `${q}: cache 0`);
  }
});
checkAsync("파이프라인: 폐쇄집합 밖 지표(통산 OPS)는 blocked", async () => {
  const fetcher = createCareerRecordFetcher(async () => BATTER_HTML, () => Date.UTC(SEASON, 7, 10));
  const { deps } = makeDeps({ fetchCareerRecord: fetcher });
  assert.equal(CAREER_METRIC_COLUMNS.batter.ops, undefined);
  const result = await answerQuestion("u1", "최형우 통산 OPS 얼마야?", deps);
  assert.equal(result.source, "blocked");
});

(async () => {
  for (const item of asyncChecks) {
    try { await item.fn(); pass += 1; console.log(`PASS ${item.name}`); }
    catch (e) { failures.push(item.name); console.log(`FAIL ${item.name} :: ${(e as Error).message}`); }
  }
  console.log(`\nbaseball QA career series: PASS=${pass} FAIL=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
})();
