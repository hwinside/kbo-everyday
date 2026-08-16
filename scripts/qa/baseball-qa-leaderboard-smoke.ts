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
 *  - 2026-08-16 하린아빠 "전반적인 답변이 너무 짧게 즉답형": 상한 320→700 + 깊이 지시문을
 *    `BASEBALL_GENIUS_DEPTH_PROMPT` **단일 SSOT** 로 통합(선수·공식·구단·뉴스·generic 5경로).
 *    문구가 4곳에 복제돼 있으면 한쪽만 고쳐져 조용히 어긋난다(2026-08-15 앵커 복제 교훈).
 *
 * 고정하는 계약:
 *  1. 지원 리더보드 질문은 kbo_structured, 미지원 지표는 history_hold fail-close.
 *  2. 인물·평가·역사 의문사는 결정론 차단이 아니라 LLM 범위판정 위임.
 *  3. 진짜 범위밖 어휘(맛집·날씨·추천…)는 여전히 차단.
 *  4. 길이 계약: RAG(선수·구단·뉴스·공식) 700 + generic 700이 **같은 값**이고, 깊이 지시문은
 *     5경로 전부 동일 SSOT 상수를 쓴다(복제 0). 상한 초과는 여전히 거부된다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  answerQuestion,
  routeQuestion,
  isCareerLeaderboardAsk,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { BASEBALL_GENIUS_MAX_ANSWER_LENGTH } from "../../src/lib/constants/baseball-genius";
import { BASEBALL_GENIUS_DEPTH_PROMPT } from "../../src/lib/baseball-qa/tone";
import {
  BASEBALL_GENIUS_ANSWER_MAX_CHARS,
  BASEBALL_GENIUS_MAX_OUTPUT_TOKENS,
  BASEBALL_GENIUS_MEASURED_WORST_TOKENS_PER_MAX_ANSWER,
  answerBudgetViolation,
} from "../../src/lib/baseball-qa/answer-budget";
import { buildBaseballQaGeminiRequest } from "../../src/lib/baseball-qa/gemini-request";
import { buildRagLlmRequest } from "../../src/lib/baseball-qa/rag/retrieve";
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
import {
  oldestFullEntryTimestamp,
  StatsFreshnessContractError,
} from "../../src/lib/stats/full-entry";
import { GET as statsGET, handleStatsGetFailure } from "../../src/app/api/stats/route";
import statsMeta from "../../src/lib/constants/stats-2026-meta.json";
import { canonicalKboId } from "../../src/lib/utils/resolve-player";
import {
  RAG_ANSWER_MAX_CHARS,
  RAG_OFFICIAL_ANSWER_MAX_CHARS,
  RAG_SYSTEM_PROMPT,
  RAG_OFFICIAL_SYSTEM_PROMPT,
  RAG_TEAM_SYSTEM_PROMPT,
  RAG_NEWS_SYSTEM_PROMPT,
  RAG_EVIDENCE_LIMIT,
  RAG_EVIDENCE_MAX_CHARS,
} from "../../src/lib/baseball-qa/rag/retrieve";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

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
check("intent 양성 전수는 라우터와 동일 SSOT로 구조화 경로에 결속된다", () => {
  for (const q of [
    "통산 안타 기록 1위는 누구야?",
    "통산 최다 안타는 누가 갖고 있어?",
    "커리어 안타 1위 알려줘",
    "누적 안타 1위 알려줘",
    "통산 안타 선두 알려줘",
    "올타임 안타 1위 누구야",
  ]) {
    // ⚠️ C안 이후 `isCareerLeaderboardAsk`(hold 판정) 는 main 그대로이므로 `커리어`·`누적`·
    // `선두` 를 모른다. 그래도 상관없다 — intent 가 hold 판정보다 **먼저** 결속되기 때문이다.
    // 여기서 검사할 계약은 "지원 intent ⇒ 구조화 경로"이고, hold 어휘 일치는 이 PR 범위가 아니다.
    assert.deepEqual(resolveCareerLeaderboardIntent(q), { metric: "hits", label: "안타" }, q);
    assert.equal(routeQuestion(q, [], PLAYERS), "career_leaderboard", q);
  }
});
check("아직 스냅샷 계약이 없는 통산 지표는 LLM 대신 hold 유지", () => {
  // 홈런 등 counting 지표는 #1169에서 공식 스냅샷 계약이 생겼다.
  // rate 지표(타율)는 여전히 구성요소 재계산 계약이 없어 fail-close 해야 한다.
  const q = "역대 최고 타율은 누구야?";
  assert.equal(isCareerLeaderboardAsk(q), true, q);
  assert.equal(routeQuestion(q, [], PLAYERS), "history_hold", q);
});
// ⚠️ 삼순 5차 P0: `STAT_WORDS`(선수 개인 기록축 토큰)에 없는 지표 alias 가 hold 조건을
// 통째로 건너뛰고 generic LLM 으로 새면, 숫자 가드로도 못 막는 **이름 단답 환각**이 난다.
// 아래 두 축은 서로를 가리지 않는다 — 지표 어휘 축(순위 표지 없음)과 순위 표지 축(미열거 지표).
// ⚠️ 2026-08-12 하린아빠 C안 — **이 PR 은 거절 범위를 건드리지 않는다.**
// 미지원 지표를 어떤 표현까지 hold 로 잡을지는 열린 언어 판정이라 13라운드를 왕복했다.
// 그 축은 별도 PR(공식 컬럼 inventory + 감사 문서 expected-set 대조)로 분리했다.
// 여기서 지키는 계약은 하나다: **hold 범위 변화량 0** — 즉 `isCareerLeaderboardAsk` 가
// main 구현(`통산|역대|올타임` + `1위|누구|누가|최다|최고`)과 동일하게 동작한다.
check("P0(C안): hold 판정은 main 구현과 동일하다 — 거절 범위 변화 0", () => {
  const mainScope = /통산|역대|올타임/;
  const mainAsk = /1\s*위|누구|누가|최다|최고/;
  const mainImpl = (question: string): boolean => {
    const normalized = question.normalize("NFKC").toLowerCase();
    return mainScope.test(normalized) && mainAsk.test(normalized);
  };
  // 이 PR 이 새로 잡거나 새로 놓아주는 표현이 하나도 없어야 한다.
  for (const q of [
    "통산 안타 1위 누구야?",
    "역대 홈런 최다 누구야?",
    "통산 폭투 1위 누구야?",
    "역대 견제사 누가 많아?",
    "통산 끝내기 상위 10명",
    "통산 폭투 제일 많은 선수",
    "역대 최고의 타자는 누구야?",
    "역대 가장 멋진 선수 누구야?",
    "누적 피로가 많으면 구속이 떨어져?",
    "커리어가 긴 투수는 부상이 많아?",
    "역대 최고의 경기 알려줘",
    "커리어 선발로 가장 기억나는 경기는?",
    "통산 선발승 1위",
    "역대 구원승 순위",
    "통산 도루 랭킹",
    "지금 홈런 1위 누구야?",
    "통산 기록이 뭐야?",
  ]) {
    assert.equal(
      isCareerLeaderboardAsk(q), mainImpl(q),
      `hold 판정이 main 과 갈라졌다(C안 위반): ${q}`,
    );
  }
});
check("P0(C안): 지원 intent 는 hold 보다 먼저 결속된다 (본목적)", () => {
  // 이 PR 의 본목적. intent 가 잡히면 hold 판정과 무관하게 구조화 경로로 간다.
  for (const q of ["통산 안타 1위 누구야?", "역대 최다안타 누구야?", "통산 안타 선두 알려줘"]) {
    assert.ok(resolveCareerLeaderboardIntent(q), `intent 미결속: ${q}`);
    assert.equal(routeQuestion(q, [], PLAYERS), "career_leaderboard", q);
  }
});
check("P0(C안): 기존 hold 범위는 유지하되 새 공식 지표 intent만 구조화 경로로 연다", () => {
  // #1159의 안타 전용 resolver는 그대로 부분집합이고, #1169의 카탈로그 resolver가 홈런을 연다.
  assert.equal(resolveCareerLeaderboardIntent("통산 홈런 1위 누구야?"), null);
  assert.equal(routeQuestion("통산 홈런 1위 누구야?", [], PLAYERS), "career_leaderboard");
  assert.equal(routeQuestion("통산 타율 1위 누구야?", [], PLAYERS), "history_hold");
});

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
  assert.match(routeSource, /const updatedAt = full\s*\? requireOldestFullEntryTimestamp\(\[currentUpdatedAt, staticGeneratedAt\]\)/);
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
    // ⚠️ 이 검사의 **본계약은 위 `intent === null`** 이다 — 범위형을 단일 1위로 오매칭해
    //   엉뚱한 이름을 단정하지 않는 것. 라우팅 라벨은 그 다음이다.
    // 2026-08-12 #1164 이후 하린아빠 exact 도 `blocked` 가 아니라 `history_hold` 다.
    //   종전에는 `안타기록` 이 `hasStat`(STAT_WORDS 13개)에 안 걸려 혼자 `blocked` 로 샜는데,
    //   #1164 가 지표 판정을 공식 컬럼 inventory 로 바꾸면서 나머지와 같은 칸으로 통일됐다.
    //   둘 다 거절이고 **바뀐 것은 안내 문구뿐**이다(실측: 11표본 전부 intent=null ·
    //   source=history_hold · LLM/RAG/cache/record 호출 0).
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
check("상한 등식 — RAG tier2 = tier1 = generic (경로별로 갈라지면 같은 질문이 다르게 잘린다)", () => {
  assert.equal(RAG_ANSWER_MAX_CHARS, 700);
  assert.equal(RAG_ANSWER_MAX_CHARS, RAG_OFFICIAL_ANSWER_MAX_CHARS);
  assert.equal(RAG_ANSWER_MAX_CHARS, BASEBALL_GENIUS_MAX_ANSWER_LENGTH);
});
// ⚠️ 깊이 지시문은 **문자열을 다시 적지 않는다**. 게이트가 프롬프트 문구를 재기술하면
//   상수를 바꿔도 게이트만 통과하는 false-green 이 생긴다(2026-08-15 "게이트가 상수를
//   재구현하면 결함을 못 본다"). 여기서는 production 상수를 그대로 import 해
//   **각 프롬프트가 그 상수를 포함하는가**만 본다.
check("깊이 지시문 SSOT — 5경로가 모두 같은 상수를 쓴다 (복제 0)", () => {
  for (const [label, prompt] of [
    ["선수 RAG", RAG_SYSTEM_PROMPT],
    ["공식 RAG", RAG_OFFICIAL_SYSTEM_PROMPT],
    ["구단 RAG", RAG_TEAM_SYSTEM_PROMPT],
    ["뉴스 RAG", RAG_NEWS_SYSTEM_PROMPT],
    ["generic", BASEBALL_QA_SYSTEM_PROMPT],
  ] as const) {
    assert.ok(prompt.includes(BASEBALL_GENIUS_DEPTH_PROMPT), `${label} 프롬프트에 깊이 SSOT 미포함`);
  }
});
check("깊이 지시문 내용 계약 — '짧게' 강제와 무근거 채움 허용이 동시에 없어야 한다", () => {
  // 하한(충분히 설명) 과 상한(근거 밖 금지) 이 **둘 다** 있어야 한다. 하나만 있으면
  // 각각 즉답 회귀 / 환각 팽창으로 기운다.
  assert.ok(BASEBALL_GENIUS_DEPTH_PROMPT.includes("충분히"), "깊이 하한 지시 소실");
  assert.ok(BASEBALL_GENIUS_DEPTH_PROMPT.includes("길이를 채우지 않는다"), "무근거 채움 금지 지시 소실");
  // 종전 즉답 강제 문구가 어느 프롬프트에도 남아 있으면 안 된다(한쪽만 고친 상태 검출).
  for (const prompt of [RAG_SYSTEM_PROMPT, RAG_OFFICIAL_SYSTEM_PROMPT, RAG_TEAM_SYSTEM_PROMPT, RAG_NEWS_SYSTEM_PROMPT, BASEBALL_QA_SYSTEM_PROMPT]) {
    assert.ok(!prompt.includes("한두 문장으로 짧게"), "즉답 강제 문구 잔존");
    assert.ok(!prompt.includes("두세 문장 이내로"), "문장 수 상한 강제 잔존");
  }
  assert.ok(BASEBALL_QA_SYSTEM_PROMPT.includes("700자 이하"));
  assert.ok(!BASEBALL_QA_SYSTEM_PROMPT.includes("320자 이하"));
});
// 🔴 삼순 2026-08-16 NO-GO P0. 문자 상한만 올리고 `maxOutputTokens` 를 두면 상한 답변이
//   JSON 중간 절단(`finishReason: MAX_TOKENS`) → validator 가 malformed 로 **전량 폐기**한다.
//   실측(gemini-flash-lite-latest): 700자 JSON 이 서술형 372 / 규칙형 392 / 수치혼합 500 /
//   지표최대밀도 552 토큰. 실호출로 max=256·384 는 MAX_TOKENS 파손, 512 부터 STOP.
check("답변 예산 정합 — 문자 상한과 토큰 상한은 같은 예산이다", () => {
  // 게이트가 조건을 재기술하지 않는다 — production 순수 함수를 그대로 태운다.
  assert.equal(answerBudgetViolation(), null, `예산 정합 위반: ${answerBudgetViolation()}`);
  // 자가검증: 이 판정 함수가 실제로 위반을 잡는가(무력화 검출).
  assert.notEqual(answerBudgetViolation(BASEBALL_GENIUS_ANSWER_MAX_CHARS, 256), null, "종전 256 토큰을 위반으로 잡지 못한다");
  assert.notEqual(
    answerBudgetViolation(BASEBALL_GENIUS_ANSWER_MAX_CHARS, BASEBALL_GENIUS_MEASURED_WORST_TOKENS_PER_MAX_ANSWER),
    null,
    "실측 최악과 같은 값(여유 0)을 위반으로 잡지 못한다",
  );
});
// 배선축: 상수만 맞고 실제 요청 body 가 옛 리터럴이면 아무 의미가 없다.
// **배포 빌더가 만든 body 를 직접 읽어** 판정한다(문자열 재기술 금지).
check("토큰 상한 실배선 — 두 요청 빌더가 같은 예산 상수를 싣는다", () => {
  const ragBody = buildRagLlmRequest("질문", [{
    content: "문보경은 LG 트윈스 소속 내야수로 별명은 문학소년이다. 충분히 긴 근거 문장입니다.",
    pageTitle: "문보경", canonicalUrl: "https://namu.wiki/w/문보경", revision: "1",
    sectionPath: "본문", asOf: "2026-01-01", sourceGrade: "tier2",
  }] as never, "system");
  const genericBody = buildBaseballQaGeminiRequest("질문", "system");
  assert.equal(ragBody.generationConfig.maxOutputTokens, BASEBALL_GENIUS_MAX_OUTPUT_TOKENS, "RAG 요청이 옛 토큰 상한을 싣는다");
  assert.equal(genericBody.generationConfig.maxOutputTokens, BASEBALL_GENIUS_MAX_OUTPUT_TOKENS, "generic 요청이 옛 토큰 상한을 싣는다");
});
check("근거 재료량 — 상한만 올리고 재료를 안 늘리면 모델이 지어내는 쪽으로 간다", () => {
  assert.equal(RAG_EVIDENCE_LIMIT, 6);
  assert.equal(RAG_EVIDENCE_MAX_CHARS, 800);
  // ⚠️ 종전 주석의 "근거상한 > 답변상한 이면 통째 복사가 성립하지 못한다"는 **false-green**
  //    이었다(삼순 2026-08-16 P1). 700자 이하 chunk 는 전문이 그대로 들어갈 수 있고, 긴
  //    chunk 도 앞 700자를 옮길 수 있다. 복사 방어는 이 부등식이 아니라 실 provider 산출물의
  //    최장 공통 부분문자열을 재는 `qa:genius-sincerity-live` 반대축이 담당한다.
  //    여기서는 두 값의 관계를 관측값으로만 남긴다(방어 주장 아님).
  assert.ok(RAG_EVIDENCE_MAX_CHARS > 0 && RAG_ANSWER_MAX_CHARS > 0);
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

checkAsync("GET 경계: freshness 계약 오류는 fallback 200으로 우회하지 않는다", async () => {
  // ⚠️ now 를 달력 날짜로 고정하면 이 검사가 **데이터 의존**이 된다: 자동 데이터 PR 이
  //   generatedAt 을 고정 now 이후로 갱신하는 순간 fallback 구성시각이 '미래'가 되어
  //   mutant(freshness 분기 제거)도 fallback 500 으로 같은 답을 내 검출력이 0 이 된다
  //   (2026-08-12~13 자동 PR 3일 연속 Preview FAIL 의 실원인, m9b MISS).
  //   now 는 repo 의 실제 generatedAt 에서 파생시켜 fallback 이 항상 '유효'한 시계로 검사한다:
  //   비변이 코드만 freshness 분기에서 500, mutant 는 fallback 200 으로 갈라진다.
  const generatedMs = Date.parse(statsMeta.battersGeneratedAt);
  assert.ok(Number.isFinite(generatedMs), "stats-2026-meta battersGeneratedAt 파싱 불가 — 게이트 전제 붕괴");
  const nowAfterGeneration = new Date(generatedMs + 60 * 60 * 1000);
  // 검출력 전제 자가검증: 이 시계에서 fallback 구성시각은 반드시 유효해야 한다.
  assert.ok(
    oldestFullEntryTimestamp([statsMeta.battersGeneratedAt], nowAfterGeneration),
    "파생 시계에서 fallback freshness 가 invalid — 이 검사는 mutant 를 검출할 수 없다",
  );
  const response = handleStatsGetFailure(
    new StatsFreshnessContractError(),
    "2026",
    "batter",
    nowAfterGeneration,
  );
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.stats.length, 0);
  assert.notEqual(body.source, "fallback");
});

checkAsync("GET call-site 실결속: 실패 경로가 handler를 통과해 freshness를 검증한다", async () => {
  // 삼순 5차 P1: handler 직접 호출만 검증하면 GET catch 가 handler 결속을 잃어도 GREEN 이다.
  // 여기서는 **실제 GET** 을 태운다 — fetch 를 죽여 catch 로 보내고, 시계를 static 생성시각
  // 이전으로 얼려 fallback 구성시각을 `미래`로 만든다. 결속이 살아 있으면 500 fail-close.
  const realFetch = globalThis.fetch;
  const RealDate = globalThis.Date;
  const frozen = new RealDate("2020-01-01T00:00:00Z").getTime();
  globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  class FrozenDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor>) {
      if (args.length === 0) super(frozen);
      else super(...(args as [string]));
    }
    static now(): number { return frozen; }
  }
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  try {
    const req = { nextUrl: new URL("https://keubo.fan/api/stats?type=batter&season=2026") };
    const response = await statsGET(req as never);
    assert.equal(response.status, 500, "미래 구성시각 fallback 이 200 으로 새면 안 된다");
    const body = await response.json();
    assert.equal(body.stats.length, 0);
    assert.notEqual(body.source, "fallback");
  } finally {
    globalThis.fetch = realFetch;
    globalThis.Date = RealDate;
  }
});

checkAsync("E2E: 캡처 exact가 history_hold/LLM이 아니라 kbo_structured로 종결된다", async () => {
  let genericLlm = 0;
  const deps = {
    loadGlossary: async () => [], loadPlayers: async () => PLAYERS,
    getCache: async () => null, setCache: async () => {},
    callLlm: async () => { genericLlm++; throw new Error("통산 정본 질문은 LLM 금지"); },
    fetchCareerMetricLeaderboard: async () => ({
      table: "batter", metric: "hits", label: "안타", unit: "안타",
      from: 1, to: 1, asOf: "2026-08-11T14:00:00Z", baselineThroughSeason: 2025,
      sourceUrl: "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx",
      rows: [{ rank: 1, kboId: "72443", name: "최형우", team: "삼성", total: 2695, baseline: 2586, current: 109 }],
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
  "맛자욱이라는 별명은 먹방 예능에서 보여준 남다른 먹성 때문에 팬들이 붙인 것입니다. " +
  "데뷔 초 방송 출연이 화제가 된 뒤 응원단이 먼저 부르기 시작했고, 홈 경기 응원가에도 등장하면서 널리 퍼졌다고 알려져 있습니다. " +
  "본인도 그 별명을 마음에 들어 해 인터뷰에서 직접 언급할 만큼 지금까지 정착했다고 합니다.";
checkAsync("E2E: 이유·배경 질문의 세 문장 답변이 잘리지 않고 그대로 나간다 (캡처 성의 축)", async () => {
  const { deps, counters } = ragDeps(FULL_ANSWER);
  const result = await answerQuestion("u1", "맛자욱 별명이 생긴 이유가 뭐야?", deps);
  // 본문 세 문장이 한 글자도 잃지 않고 나가고, 출처 표기만 뒤에 붙는다.
  assert.ok(result.answer.startsWith(FULL_ANSWER), `세 문장 전체가 그대로 나가야 한다: ${result.answer}`);
  assert.ok(result.answer.includes("출처"), "출처 표기 유지");
  assert.ok(FULL_ANSWER.length > 160, "종전 상한(160)을 실제로 넘는 표본이어야 상향이 검증된다");
  assert.equal(counters.llm, 1);
});
checkAsync("E2E 반대축: 상한 초과 답변은 여전히 거부된다 (상한 상향이 무제한 아님)", async () => {
  const over = "가".repeat(RAG_ANSWER_MAX_CHARS + 20);
  const { deps } = ragDeps(over);
  const result = await answerQuestion("u1", "맛자욱 별명이 생긴 이유가 뭐야?", deps);
  assert.notEqual(result.answer, over, "상한 초과가 그대로 나가면 상한이 죽은 것");
});
// 상향의 **실효**를 종단으로 고정한다. 종전 상한(320)을 넘는 길이의 근거 기반 답이
// 한 글자도 잃지 않고 유저에게 도달해야 상향이 실제로 동작한 것이다.
checkAsync("E2E 실효축: 종전 상한(320)을 넘는 풍부한 답변이 잘리지 않고 그대로 나간다", async () => {
  const rich = `${FULL_ANSWER} ${"응원단의 구호에도 이 별명이 쓰이면서 팬들 사이에서는 애칭처럼 자리를 잡았다고 전해집니다.".repeat(4)}`;
  assert.ok(rich.length > 320, "표본이 종전 상한을 넘어야 상향이 검증된다");
  assert.ok(rich.length <= RAG_ANSWER_MAX_CHARS, "표본이 새 상한 안이어야 통과가 정상이다");
  const { deps } = ragDeps(rich);
  const result = await answerQuestion("u1", "맛자욱 별명이 생긴 이유가 뭐야?", deps);
  assert.ok(result.answer.startsWith(rich), `본문 전체가 그대로 나가야 한다: ${result.answer}`);
});

(async () => {
  for (const item of asyncChecks) {
    try { await item.fn(); pass += 1; console.log(`PASS ${item.name}`); }
    catch (e) { failures.push(item.name); console.log(`FAIL ${item.name} :: ${(e as Error).message}`); }
  }
  console.log(`\nbaseball QA leaderboard: PASS=*** FAIL=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
})();
