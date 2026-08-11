/**
 * 리그 통산·역대 순위 공식 구조화 조회 + 범위밖 denylist 인물 축 삭제 + 답변 성의(길이) 계약.
 *
 * 배경 (2026-08-10 하린아빠 캡처 + 삼순 NO-GO):
 *  - `통산 안타 기록 1위는 누구야?` 를 generic LLM 에 위임하면 숫자 가드를 피해도
 *    **오래된 이름을 확신해서 내보내는 오답**(손아섭 — 실제 1위는 최형우)을 못 잡는다.
 *    2026-08-11 실측으로 `BasicTotal.aspx` 통산 정본이 확인됐다. 전년도 말 기준선에
 *    당해 시즌 스냅샷을 더해 현재 통산값을 결정론적으로 계산한다.
 *  - `작년 LG우승에 가장 큰 기여를 한 사람은 누구야?` 가 denylist `누구` 축에 걸려
 *    전면 차단 → 인물·평가·역사 축을 denylist 에서 삭제(범위 판정은 LLM 위임).
 *  - `맛자욱 별명` 단답 → tier1·tier2·generic 전 경로 길이 계약: 유형별 목표(단순=짧게,
 *    이유·배경=충분히) + 안전 상한(RAG 320 / generic 320).
 *
 * 고정하는 계약:
 *  1. 지원 리더보드 질문은 kbo_structured, 미지원 지표는 history_hold fail-close.
 *  2. 인물·평가·역사 의문사는 결정론 차단이 아니라 LLM 범위판정 위임.
 *  3. 진짜 범위밖 어휘(맛집·날씨·추천…)는 여전히 차단.
 *  4. 길이 계약: RAG(선수·구단·뉴스) 320 + 성의 지시, generic 320 + 성의 지시.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  answerQuestion,
  routeQuestion,
  isCareerLeaderboardAsk,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { BASEBALL_GENIUS_MAX_ANSWER_LENGTH } from "../../src/lib/constants/baseball-genius";
import {
  composeCareerLeaderboardAnswer,
  resolveCareerLeaderboard,
  resolveCareerLeaderboardIntent,
} from "../../src/lib/baseball-qa/stats/career-leaderboard";
import {
  SERVED_BATTER_FULL_ENTRY_IDS,
  validateServedBatterPayload,
} from "../../src/lib/baseball-qa/stats/served-record";
import { BASEBALL_QA_SYSTEM_PROMPT } from "../../src/lib/baseball-qa/gemini-request";
import { oldestFullEntryTimestamp } from "../../src/lib/stats/full-entry";
import { canonicalKboId } from "../../src/lib/utils/resolve-player";
import {
  RAG_ANSWER_MAX_CHARS,
  RAG_OFFICIAL_ANSWER_MAX_CHARS,
  RAG_SYSTEM_PROMPT,
  RAG_TEAM_SYSTEM_PROMPT,
  RAG_NEWS_SYSTEM_PROMPT,
} from "../../src/lib/baseball-qa/rag/retrieve";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
}

const PLAYERS = [
  { kboId: "72443", name: "최형우", team: "삼성", position: "외야수" },
] as unknown as PlayerRef[];

// ── 1. 리더보드 = 공식 구조화 조회, 미지원 지표는 fail-close ──
check("통산 안타 1위는 공식 구조화 조회로 위임한다", () => {
  for (const q of ["통산 안타 기록 1위는 누구야?", "통산 최다 안타는 누가 갖고 있어?"]) {
    assert.equal(isCareerLeaderboardAsk(q), true, q);
    assert.deepEqual(resolveCareerLeaderboardIntent(q), { metric: "hits", label: "안타" });
    assert.equal(routeQuestion(q, [], PLAYERS), "career_leaderboard", q);
  }
});
check("아직 스냅샷 계약이 없는 통산 지표는 LLM 대신 hold 유지", () => {
  for (const q of ["역대 홈런 1위 누구야?", "역대 최고 타율은 누구야?"]) {
    assert.equal(isCareerLeaderboardAsk(q), true, q);
    assert.equal(routeQuestion(q, [], PLAYERS), "history_hold", q);
  }
});

// ── 2. denylist 인물 축 삭제 (캡처: `작년 LG우승에 가장 큰 기여를 한 사람은 누구야?`) ──
check("야구 인물 질문은 결정론 차단이 아니라 위임이다 (캡처 exact 포함)", () => {
  for (const q of [
    "작년 LG우승에 가장 큰 기여를 한 사람은 누구야?", // `LG우승` 결합 토큰 — 팀 면제도 못 타던 표본
    "작년 한국시리즈 MVP 누구야?",
    "LG트윈스 감독 누구야?",
    "역대 최고의 타자는 누구야?", // 지표 없는 주관 평가 — 리더보드 아님, LLM 범위판정
  ]) {
    assert.equal(routeQuestion(q, [], []), "llm_scope_gate", q);
  }
});
check("진짜 범위밖 어휘는 여전히 차단된다 (denylist 축소 방향 안전핀)", () => {
  for (const q of ["LG 경기장 근처 맛집 추천해줘", "오늘 저녁 메뉴 추천", "날씨 어때?"]) {
    assert.equal(routeQuestion(q, [], []), "blocked", q);
  }
});

/** 리그 전체 규모의 2026 current rows 표본(기본 300행) — 빈/부분 응답 fail-close 계약의 양성 쪽. */
function makeCurrentRows(updatedAt = "2026-08-11T14:00:00Z") {
  return SERVED_BATTER_FULL_ENTRY_IDS.map((id, index) => ({
    kbo_id: id, player_key: id,
    name: id === "77532" ? "손아섭" : id === "72443" ? "최형우" : `현역${index}`,
    team: id === "77532" ? "두산" : id === "72443" ? "삼성" : "팀",
    hits: id === "77532" ? 35 : id === "72443" ? 109 : index % 150,
    updated_at: updatedAt,
  }));
}
function makeBaselineSnapshot() {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    kboId: String(70000 + index), name: `선수${index}`, team: "팀", hits: Math.max(0, 2500 - index),
  }));
  rows[0] = { kboId: "77532", name: "손아섭", team: "두산", hits: 2618 };
  rows[1] = { kboId: "72443", name: "최형우", team: "삼성", hits: 2586 };
  return {
    schemaVersion: 1, throughSeason: 2025, rowCount: rows.length, rows,
    source: { url: "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx", seasonValue: "9999", sortKey: "HIT_CN", order: "DESC" },
  };
}

check("기준선 + 올시즌 증분이 현재 통산 1위를 뒤집어 계산한다 (+출처 표기)", () => {
  const snapshot = makeBaselineSnapshot();
  const current = makeCurrentRows();
  const result = resolveCareerLeaderboard(snapshot, current as never, "2026-08-11T14:00:00Z", { metric: "hits", label: "안타" }, new Date("2026-08-11T15:00:00Z"));
  assert.equal(result?.leaders[0].name, "최형우");
  assert.equal(result?.leaders[0].total, 2695);
  const answer = composeCareerLeaderboardAnswer(result!);
  assert.ok(answer.includes("2,695안타"));
  assert.ok(answer.includes("출처") && answer.includes("KBO 공식 기록실"), `답변에 출처 표기가 있어야 한다: ${answer}`);
});

check("P0: 유효 기준선 + 빈/부분 currentRows 는 fail-close (2025값 단정 금지)", () => {
  const intent = { metric: "hits", label: "안타" } as const;
  const snapshot = makeBaselineSnapshot();
  const now = new Date("2026-08-11T15:00:00Z");
  assert.equal(resolveCareerLeaderboard(snapshot, [], "2026-08-11T14:00:00Z", intent, now), null, "빈 currentRows");
  assert.equal(resolveCareerLeaderboard(snapshot, makeCurrentRows().slice(0, 100) as never, "2026-08-11T14:00:00Z", intent, now), null, "임의 100행 currentRows");
  const missingLeader = makeCurrentRows().filter((row) => row.kbo_id !== "72443");
  assert.equal(resolveCareerLeaderboard(snapshot, missingLeader as never, "2026-08-11T14:00:00Z", intent, now), null, "known full-entry ID 1개 누락");
});

check("P0: /api/stats envelope type/count + known full-entry ID coverage 계약", () => {
  const rows = makeCurrentRows().map((row) => ({ ...row, kboId: row.kbo_id }));
  assert.equal(validateServedBatterPayload({ stats: rows, type: "batter", count: rows.length })?.length, rows.length);
  assert.equal(validateServedBatterPayload({ stats: rows, type: "pitcher", count: rows.length }), null, "type 변형");
  assert.equal(validateServedBatterPayload({ stats: rows, type: "batter", count: rows.length - 1 }), null, "count 불일치");
  assert.equal(validateServedBatterPayload({ stats: rows.slice(0, 100), type: "batter", count: 100 }), null, "임의 100행");
  const missingKnownId = rows.filter((row) => row.kboId !== SERVED_BATTER_FULL_ENTRY_IDS[0]);
  assert.equal(validateServedBatterPayload({ stats: missingKnownId, type: "batter", count: missingKnownId.length }), null, "known ID 누락");
  // 운영 실형태: static 숫자 54400과 full 응답 FP006은 같은 선수여야 coverage가 닫힌다.
  assert.equal(canonicalKboId("54400"), "FP006");
  assert.ok(SERVED_BATTER_FULL_ENTRY_IDS.includes("FP006"));
  assert.ok(!SERVED_BATTER_FULL_ENTRY_IDS.includes("54400"));
});

check("P0: baseline 숫자 외국인 ID와 current canonical 영문 ID를 같은 선수로 결합", () => {
  const snapshot = makeBaselineSnapshot();
  snapshot.rows[0] = { kboId: "54400", name: "외국인표본", team: "팀", hits: 3000 };
  const current = makeCurrentRows().map((row) => row.kbo_id === "FP006"
    ? { ...row, name: "외국인표본", hits: 10 }
    : row);
  const result = resolveCareerLeaderboard(snapshot, current as never, "2026-08-11T14:00:00Z", { metric: "hits", label: "안타" }, new Date("2026-08-11T15:00:00Z"));
  assert.equal(result?.leaders[0].kboId, "FP006");
  assert.equal(result?.leaders[0].total, 3010);
});

check("P0: full=1 freshness는 모든 구성시각 검증 후 가장 오래된 시각", () => {
  const now = new Date("2026-08-12T01:00:00Z");
  assert.equal(
    oldestFullEntryTimestamp(["2026-08-12T01:00:00Z", "2026-08-10T20:21:46.603Z"], now),
    "2026-08-10T20:21:46.603Z",
  );
  assert.equal(oldestFullEntryTimestamp(["2026-08-12T01:00:00Z", undefined], now), null, "구성시각 누락 fail-close");
  assert.equal(
    oldestFullEntryTimestamp(["2026-08-12T01:00:00Z", "2026-08-13T01:00:00Z"], now),
    null,
    "미래 static을 min 계산으로 숨기면 안 된다",
  );
  const routeSource = readFileSync("src/app/api/stats/route.ts", "utf8");
  assert.match(routeSource, /const updatedAt = full\s*\? oldestFullEntryTimestamp\(\[currentUpdatedAt, staticGeneratedAt\]\)/);
  assert.match(routeSource, /statsMeta\.battersGeneratedAt/);
});

check("P0: current 컬럼 원타입 변형(hits '109' 문자열·필드 누락)은 fail-close", () => {
  const intent = { metric: "hits", label: "안타" } as const;
  const snapshot = makeBaselineSnapshot();
  const now = new Date("2026-08-11T15:00:00Z");
  const stringTyped = [
    ...makeCurrentRows().filter((row) => row.kbo_id !== "72443"),
    { kbo_id: "72443", player_key: "72443", name: "최형우", team: "삼성", hits: "109", updated_at: "2026-08-11T14:00:00Z" },
  ];
  assert.equal(resolveCareerLeaderboard(snapshot, stringTyped as never, "2026-08-11T14:00:00Z", intent, now), null, "문자열 hits");
  const missing = [
    ...makeCurrentRows().filter((row) => row.kbo_id !== "72443"),
    { kbo_id: "72443", player_key: "72443", name: "최형우", team: "삼성", updated_at: "2026-08-11T14:00:00Z" },
  ];
  assert.equal(resolveCareerLeaderboard(snapshot, missing as never, "2026-08-11T14:00:00Z", intent, now), null, "hits 필드 누락");
});

check("P0: 범위형(1위부터 10위)은 단일 1위로 오매칭하지 않고 hold 로 내려간다", () => {
  for (const q of [
    "통산 안타기록 기준으로 현재까지 1위부터 10위까지가 누구누구야?", // 하린아빠 exact
    "통산 안타 1위부터 5위 알려줘",
    "통산 안타 상위 10명 누구야?",
    "통산 안타 top10 알려줘",
    "통산 안타 3위 누구야?",
    "통산 안타 최다 10명 알려줘", // 삼순 2차 NO-GO exact
    "통산 안타 최다 두 명 알려줘", // 삼순 3차 NO-GO exact
    "통산 안타 1위는 누구고 2위는 누구야?", // 삼순 4차 NO-GO: 부분절 consume 금지
    "통산 홈런 1위는 누구야? 안타도 궁금해", // 삼순 4차 NO-GO: 타 지표 절의 안타 오결속 금지
    // ⚠️ 아래 두 표본은 각각 rankTokens 폐쇄·범위 표지 폐쇄를 **단독으로** 무너뜨린다.
    // 표지 없는 복수 순위(1위 2위)는 rankTokens 만, 1위+부터는 범위 표지만 잡는다 —
    // 하나가 빠져도 다른 가드가 가려 mutation 검출력이 0이 되는 것을 막는 쌍이다.
    "통산 안타 1위 2위 누구야?",
    "통산 안타 1위부터 알려줘",
  ]) {
    assert.equal(resolveCareerLeaderboardIntent(q), null, q);
    assert.equal(routeQuestion(q, [], PLAYERS), "history_hold", q);
  }
});
check("결함주입: 빈/낡은/중복 identity/컬럼 변형은 fail-close", () => {
  const intent = { metric: "hits", label: "안타" } as const;
  const rows = Array.from({ length: 100 }, (_, index) => ({
    kboId: String(70000 + index), name: `선수${index}`, team: "팀", hits: 2500 - index,
  }));
  const valid = {
    schemaVersion: 1, throughSeason: 2025, rowCount: rows.length, rows,
    source: { url: "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx", seasonValue: "9999", sortKey: "HIT_CN", order: "DESC" },
  };
  const fullCurrent = makeCurrentRows();
  assert.equal(resolveCareerLeaderboard({}, fullCurrent as never, "2026-08-11T14:00:00Z", intent, new Date("2026-08-11T15:00:00Z")), null, "empty baseline");
  assert.equal(resolveCareerLeaderboard(valid, fullCurrent as never, "2026-08-09T14:00:00Z", intent, new Date("2026-08-11T15:00:00Z")), null, "stale");
  assert.equal(resolveCareerLeaderboard(valid, [
    ...fullCurrent,
    { kbo_id: "70000", player_key: "70000", name: "선수0", team: "팀", hits: 1, updated_at: "2026-08-11T14:00:00Z" },
    { kbo_id: "70000", player_key: "70000", name: "선수0", team: "팀", hits: 1, updated_at: "2026-08-11T14:00:00Z" },
  ] as never, "2026-08-11T14:00:00Z", intent, new Date("2026-08-11T15:00:00Z")), null, "duplicate identity");
  const swapped = { ...valid, rows: rows.map((row, index) => index === 0 ? { ...row, hits: "2500" } : row) };
  assert.equal(resolveCareerLeaderboard(swapped, fullCurrent as never, "2026-08-11T14:00:00Z", intent, new Date("2026-08-11T15:00:00Z")), null, "H column type swap");
});

check("무회귀: 선수 지명·시점어 없는 질문은 리더보드가 아니다", () => {
  assert.equal(routeQuestion("최형우 통산 타율 알려줘", [], PLAYERS), "history_hold");
  assert.equal(isCareerLeaderboardAsk("지금 홈런 1위 누구야?"), false);
  assert.equal(isCareerLeaderboardAsk("통산 기록이 뭐야?"), false);
});

// ── 3. 길이·성의 계약 — 전 경로 (선수·구단·뉴스 RAG + generic) ─────────────────
check("tier2 상한 320 = tier1, 선수 RAG 성의 지시", () => {
  assert.equal(RAG_ANSWER_MAX_CHARS, 320);
  assert.equal(RAG_ANSWER_MAX_CHARS, RAG_OFFICIAL_ANSWER_MAX_CHARS);
  assert.ok(RAG_SYSTEM_PROMPT.includes("이유·배경·사연을 묻는 질문은 자료 안의 맥락을 두세 문장으로 충분히 설명한다"));
  assert.ok(RAG_SYSTEM_PROMPT.includes("자료에 없는 내용을 보태 길이를 채우지 않는다"));
});
check("구단 RAG 도 같은 성의 계약이다 — 한두 문장 강제 잔존 금지 (삼순 축 ③)", () => {
  assert.ok(RAG_TEAM_SYSTEM_PROMPT.includes("이유·배경·사연을 묻는 질문은 자료 안의 맥락을 두세 문장으로 충분히 설명한다"));
  assert.ok(!RAG_TEAM_SYSTEM_PROMPT.includes("한두 문장으로 다시 서술"));
});
check("뉴스 RAG 성의 계약", () => {
  assert.ok(RAG_NEWS_SYSTEM_PROMPT.includes("두세 문장으로 충분히"));
});
check("generic 상한 320 + 성의 지시 (200자 계약 폐기)", () => {
  assert.equal(BASEBALL_GENIUS_MAX_ANSWER_LENGTH, 320);
  assert.ok(BASEBALL_QA_SYSTEM_PROMPT.includes("320자 이하"));
  assert.ok(!BASEBALL_QA_SYSTEM_PROMPT.includes("200자 이하"));
  assert.ok(BASEBALL_QA_SYSTEM_PROMPT.includes("이유·배경·사연·과정을 묻는 질문은 두세 문장으로 충분히"));
});

// ── 4. 성의 축 — 실제 생성답 E2E (삼순 2026-08-10: 프롬프트 문자열 단정만으로는
// 행동 개선이 검증되지 않는다). RAG 경로에 두세 문장·250자 답을 물려 **그대로**
// 유저에게 나가는지, 320 초과는 여전히 거부되는지 종단으로 고정한다.
const RAG_PLAYERS = [
  { kboId: "55555", name: "맛자욱", team: "LG", position: "내야수" },
] as unknown as PlayerRef[];
// ⚠️ deterministic 답(FULL_ANSWER)의 **모든 사실은 이 근거 안에 있어야 한다** (삼순
// 3차: 근거 밖 사실을 정답으로 고정하면 게이트가 환각을 승인하는 셈이다).
const RAG_EVIDENCE = [{
  content: "맛자욱은 먹방 예능에서 보여준 남다른 먹성 때문에 팬들이 맛자욱이라는 별명을 붙였다고 알려져 있다. 데뷔 초 방송 출연이 화제가 된 뒤 응원단이 먼저 부르기 시작했고, 홈 경기 응원가에도 등장하면서 널리 퍼졌다. 본인도 그 별명을 마음에 들어해 인터뷰에서 직접 언급했으며 지금까지 정착했다.",
  pageTitle: "맛자욱", canonicalUrl: "https://namu.wiki/w/맛자욱", revision: "1",
  sectionPath: "별명", asOf: "2026-01-01", sourceGrade: "tier2",
}];
function ragDeps(llmAnswer: string): { deps: QaDeps; counters: { llm: number } } {
  const counters = { llm: 0 };
  let stored: unknown = null;
  let started = false;
  const deps = {
    loadGlossary: async () => [],
    loadPlayers: async () => RAG_PLAYERS,
    getCache: async () => null,
    setCache: async () => {},
    enablePlayerRag: true,
    searchRag: async () => RAG_EVIDENCE as never,
    callRagLlm: async () => {
      counters.llm++;
      return { text: JSON.stringify({ status: "GROUNDED", answer: llmAnswer }), inputTokens: 10, outputTokens: 5 };
    },
    callLlm: async () => { throw new Error("선수 RAG 질문에서 generic LLM 금지"); },
    searchOfficialRag: async () => { throw new Error("선수 질문은 공식 RAG 미사용"); },
    callOfficialRagLlm: async () => { throw new Error("선수 질문은 공식 RAG 미사용"); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async () => {},
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (r: unknown) => { stored = r; },
  } as unknown as QaDeps;
  return { deps, counters };
}
const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function checkAsync(name: string, fn: () => Promise<void>) { asyncChecks.push({ name, fn }); }

checkAsync("E2E: 캡처 exact가 history_hold/LLM이 아니라 kbo_structured로 종결된다", async () => {
  let genericLlm = 0;
  const deps = {
    loadGlossary: async () => [], loadPlayers: async () => PLAYERS,
    getCache: async () => null, setCache: async () => {},
    callLlm: async () => { genericLlm++; throw new Error("통산 정본 질문은 LLM 금지"); },
    fetchCareerLeaderboard: async () => ({
      metric: "hits", label: "안타", asOf: "2026-08-11T14:00:00Z", baselineThroughSeason: 2025,
      sourceUrl: "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx",
      leaders: [{ kboId: "72443", name: "최형우", team: "삼성", total: 2695, baseline: 2586, current: 109 }],
    }),
    reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
  } as unknown as QaDeps;
  const result = await answerQuestion("u1", "통산 안타 기록 1위는 누구야?", deps);
  assert.equal(result.source, "kbo_structured");
  assert.ok(result.answer.includes("최형우(삼성)"));
  assert.ok(result.answer.includes("2,695안타"));
  assert.equal(genericLlm, 0);
});

const FULL_ANSWER =
  "맛자욱이라는 별명은 먹방 예능에서 보여준 남다른 먹성 때문에 팬들이 붙여준 거예요. " +
  "데뷔 초 방송 출연이 화제가 된 뒤 응원단이 먼저 부르기 시작했고, 홈 경기 응원가에도 등장하면서 널리 퍼졌다고 알려져 있어요. " +
  "본인도 그 별명을 마음에 들어해서 인터뷰에서 직접 언급할 만큼 지금까지 정착했다고 해요.";
checkAsync("E2E: 이유·배경 질문의 세 문장 답변이 잘리지 않고 그대로 나간다 (캡처 성의 축)", async () => {
  const { deps, counters } = ragDeps(FULL_ANSWER);
  const result = await answerQuestion("u1", "맛자욱 별명이 생긴 이유가 뭐야?", deps);
  // 본문 세 문장이 한 글자도 잃지 않고 나가고, 출처 표기만 뒤에 붙는다.
  assert.ok(result.answer.startsWith(FULL_ANSWER), `세 문장 전체가 그대로 나가야 한다: ${result.answer}`);
  assert.ok(result.answer.includes("출처"), "출처 표기 유지");
  assert.ok(FULL_ANSWER.length > 160, "종전 상한(160)을 실제로 넘는 표본이어야 상향이 검증된다");
  assert.equal(counters.llm, 1);
});
checkAsync("E2E 반대축: 320 초과 답변은 여전히 거부된다 (상한 상향이 무제한 아님)", async () => {
  const over = "가".repeat(340);
  const { deps } = ragDeps(over);
  const result = await answerQuestion("u1", "맛자욱 별명이 생긴 이유가 뭐야?", deps);
  assert.notEqual(result.answer, over, "320 초과가 그대로 나가면 상한이 죽은 것");
});

(async () => {
  for (const item of asyncChecks) {
    try { await item.fn(); pass += 1; console.log(`PASS ${item.name}`); }
    catch (e) { failures.push(item.name); console.log(`FAIL ${item.name} :: ${(e as Error).message}`); }
  }
  console.log(`\nbaseball QA leaderboard: PASS=*** FAIL=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
})();
