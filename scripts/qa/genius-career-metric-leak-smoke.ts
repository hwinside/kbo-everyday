#!/usr/bin/env tsx
/**
 * 통산·역대 리더보드 질문의 **generic LLM 누수 차단** 게이트.
 *
 * ⚠️ 왜 필요한가 (2026-08-12 실측).
 * 종전 라우팅은 이 축을 `STAT_WORDS`(13개)로 판정했다. KBO 공식 기록실 컬럼 **75개
 * (판정 어휘 96개)** 로 `통산 <지표> 1위 누구야?` 를 전수 돌려보니 **다수가 `llm_scope_gate`로 샜다**
 * (`탈삼진`·`완봉`·`이닝`·`실책`·`선발승`·`견제사`…). 리더보드 답은 **이름 단답**이라
 * 숫자 환각 게이트에 걸리지 않는다 — 모델이 기억하는 옛 1위를 확신해서 내보낸다
 * (8/9 `임창규` 사고와 같은 축).
 *
 * 이 게이트가 지키는 것:
 *   ⓪ (A안 계약) 판정은 **어휘 포함 여부만** — 지표어 뒤 결합을 보지 않는다. 다의어 과차단은
 *      수용하고, 누수 0 을 우선한다. 근거는 `hasCareerMetricTerm` 주석의 실측 트레이드오프.
 *   ① 공식 컬럼 어휘 전수 × 통산 요청 형태(팀 한정 포함) → generic LLM 도달 0
 *   ② 반대편 과차단 0 — 지표 어휘가 없는 서술·주관 질문은 그대로 LLM 범위 판정
 *   ③ 판정 어휘는 감사 문서 expected-set 과 missing/extra 0 (독립 근거 대조)
 *   ④ 기존 경로 무회귀 (선수 지목·구단 수치·당해 시즌)
 *   ⑤ **종단(`answerQuestion`) 검증** — 라우터만 보면 production 을 증명하지 못한다.
 *      지원 지표의 구조화 실답 보존 + 미지원 지표의 생성·검색 경로 도달 0.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  answerQuestion,
  hasCareerMetricTerm,
  isCareerLeaderboardAsk,
  routeQuestion,
  type QaDeps,
  type QuestionRoute,
} from "../../src/lib/baseball-qa/pipeline";
import { createCareerRecordFetcher } from "../../src/lib/baseball-qa/stats/career-series";
import {
  KBO_OFFICIAL_GENERAL_TERMS,
  KBO_OFFICIAL_METRIC_COLUMNS,
  KBO_OFFICIAL_METRIC_TERMS,
} from "../../src/lib/baseball-qa/stats/kbo-official-metric-columns";
import {
  DERIVED_RATIO,
  DOCUMENTED_EXCLUSIONS,
  parseExpectedColumns,
} from "./kbo-metric-inventory-expected.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const PLAYERS = [
  { kboId: "50000", name: "김도영", team: "KIA" },
  { kboId: "60000", name: "최형우", team: "삼성" },
] as never;

/** 통산 축을 여는 요청 형태 — `CAREER_LEADERBOARD_ASK`(main 그대로)가 인정하는 것들. */
const CAREER_ASK_FORMS = [
  (term: string) => `통산 ${term} 1위 누구야?`,
  (term: string) => `역대 ${term} 최다 누구야?`,
  (term: string) => `올타임 ${term} 1위 누가야`,
  (term: string) => `통산 ${term} 최고 기록 누구야?`,
];

/**
 * **열린 요청 표현** — 1차 tail 화이트리스트가 여기서 대량 누수했다(삼순 2차 P0).
 * `가장 많은`·`제일 많은` 은 화이트리스트로 못 잡는 형태이고, `<지표>승` 은 어휘 접미가
 * 달라 매칭이 끊기는 형태다. A안(어휘 포함 여부만) 계약의 회귀 앵커로 함께 전수 돌린다.
 */
const CAREER_OPEN_ASK_FORMS = [
  (term: string) => `역대 ${term}이 가장 많은 선수 누구야?`,
  (term: string) => `통산 ${term} 제일 많은 선수 누구야?`,
  (term: string) => `역대 ${term}승 1위 누구야?`,
];

/**
 * **팀을 붙인 통산 질문** — 라우팅에 `!hasTeam` 이 있으면 여기서 대량 누수한다
 * (삼순 #1164 4차 P0 실측: 288 조합 중 165건이 `llm_scope_gate`).
 * 팀을 붙였다고 리그 통산 리더보드를 답할 수 있게 되는 것이 아니다 — 구단별 통산 정본은
 * 더 없다. 구단 **당해 시즌** 수치는 team 축이 그대로 처리하므로 무회귀는 아래에서 따로 본다.
 */
const CAREER_TEAM_ASK_FORMS = [
  (term: string) => `LG 통산 ${term} 1위 누구야?`,
  (term: string) => `기아 역대 ${term} 최다 누구야?`,
  (term: string) => `삼성 통산 ${term}이 가장 많은 선수 누구야?`,
];

/**
 * **선수를 지목한 통산 질문** + 팀·선수 복합. 자체 전수 훑기에서 찾은 누수 축이다.
 * 아래 `hasStat && hasPlayerReference && !hasTeam` 라인이 이 부류를 받지만 그 조건도
 * `STAT_WORDS`(13개)라, 공식 어휘가 그 목록 밖이면 샜다(192 조합 중 75건). 팀+선수 복합은
 * 그 라인의 `!hasTeam` 때문에 더 크게 샜다. 선수 지목 통산 질문은 조회 배선이 없어 이미
 * 전부 hold 이므로, 여기서 닫는 것이 답변 경로를 빼앗지 않는다.
 */
const CAREER_PLAYER_ASK_FORMS = [
  (term: string) => `김도영 통산 ${term} 1위야?`,
  (term: string) => `최형우 역대 ${term} 최다 맞아?`,
  (term: string) => `LG 김도영 통산 ${term} 1위 누구야?`,
];

/** generic LLM 으로 내려가는 라우트 — 이 축에서는 하나도 나와서는 안 된다. */
const LLM_ROUTES: QuestionRoute[] = ["llm_scope_gate"];

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name} :: ${message}`);
    console.error(`FAIL ${name} :: ${message}`);
  }
}

check("P0: 공식 컬럼 어휘 × 요청 형태 전수 — generic LLM 도달 0", () => {
  // ⚠️ 조합 수를 **게이트가 계산해 출력한다**(삼순 #1164 3차 지적). 종전에는 보고문에
  // 손으로 쓴 수치(480)가 게이트의 실제 열거(4×96=384)와 어긋났다. 숫자의 SSOT 는 이 출력이다.
  const forms = [
    ...CAREER_ASK_FORMS,
    ...CAREER_OPEN_ASK_FORMS,
    ...CAREER_TEAM_ASK_FORMS,
    ...CAREER_PLAYER_ASK_FORMS,
  ];
  const leaks: string[] = [];
  let combinations = 0;
  for (const term of KBO_OFFICIAL_METRIC_TERMS) {
    for (const form of forms) {
      combinations += 1;
      const question = form(term);
      const route = routeQuestion(question, [], PLAYERS);
      if (LLM_ROUTES.includes(route)) leaks.push(`${question} -> ${route}`);
    }
  }
  console.log(
    `     전수 조합 ${forms.length}형태 × ${KBO_OFFICIAL_METRIC_TERMS.length}어휘 = ` +
    `${combinations} / 누수 ${leaks.length}`,
  );
  assert.equal(combinations, forms.length * KBO_OFFICIAL_METRIC_TERMS.length);
  assert.deepEqual(
    leaks, [],
    `공식 지표 ${leaks.length}건이 generic LLM 으로 샌다:\n  ${leaks.slice(0, 12).join("\n  ")}`,
  );
});

check("P0: 실측 누수 대표 표본이 fail-close 된다", () => {
  // 2026-08-12 실측에서 실제로 샜던 어휘들. 회귀하면 여기서 먼저 터진다.
  for (const term of [
    "탈삼진", "완봉", "완투", "이닝", "실책", "선발승", "구원승", "견제사", "주루사",
    "다승", "자책점", "피안타", "폭투", "볼넷", "득점", "루타", "병살", "퀄리티스타트",
  ]) {
    const question = `통산 ${term} 1위 누구야?`;
    assert.equal(hasCareerMetricTerm(question), true, `지표 미인식: ${term}`);
    assert.equal(routeQuestion(question, [], PLAYERS), "history_hold", question);
  }
});

check("P0: 삼순 2차 exact — 어휘 접미/열린 요청 표현도 fail-close", () => {
  // ⚠️ 1차 tail 화이트리스트가 과차단을 줄인 대신 **실제 목표 자연어를 누락**시켰다.
  //   `역대 완봉승 1위`        — 어휘는 `완봉` 까지만 매칭돼 tail 이 `승1위`
  //   `역대 탈삼진이 가장 많은 선수` — 조사 뒤 tail 이 `가장많은`
  // 실측 149/288 누수. tail 을 늘리는 대신 폐기했다(A안). 이 두 exact 가 그 계약의 앵커다.
  for (const question of [
    "역대 완봉승 1위 누구야?",
    "역대 탈삼진이 가장 많은 선수 누구야?",
    "통산 완투승 1위 누구야?",
    "통산 탈삼진수 1위 누구야?",
    "통산 홈런 제일 많은 선수 누구야?",
  ]) {
    assert.equal(hasCareerMetricTerm(question), true, `지표 미인식: ${question}`);
    assert.equal(routeQuestion(question, [], PLAYERS), "history_hold", question);
  }
});

check("P0: 지표어에 조사가 붙어도 fail-close (조사 처리 결속)", () => {
  // 실사용 다수 형태다. 조사를 벗기지 않으면 뒤결합 판정이 조사에 막혀 전부 샌다.
  for (const question of [
    "통산 홈런은 누가 1위야?",
    "역대 최다 안타는 누구야?",
    "통산 세이브는 누가 1위야?",
    // ⚠️ `통산 이닝이 가장 많은 기록 누구야?` 는 넣지 않는다. 뒤결합이 `가장 많은` 이라
    // 화이트리스트에 `가장`·`많` 을 넣어야 통과하는데, 그건 **열린 언어**를 다시 쫓는 것이다
    // (#1159 6~13차 교훈). 이 축은 요청 형태 판정(main)의 몫으로 남긴다.
  ]) {
    assert.equal(hasCareerMetricTerm(question), true, `조사 결합 미인식: ${question}`);
    assert.equal(routeQuestion(question, [], PLAYERS), "history_hold", question);
  }
});

check("P0: 띄어쓰기 변이도 fail-close (공백 정규화 결속)", () => {
  // ⚠️ 삼순 #1164 1차 P0-1: 종전 게이트에는 이 표본이 없어 공백 정규화를 제거해도 GREEN 이었고,
  // 나는 그 mutation 을 `expectRed:false` 로 성공 처리해 RED 카운트에 포함시켰다(false RED).
  // 정규화가 실제로 필요한 표본을 넣어야 그 축이 게이트가 된다.
  for (const question of [
    "통산 탈 삼진 1위 누구야?",
    "역대 몸에 맞는 공 최다 누구야?",
    "통산 퀄리티 스타트 1위 누구야?",
  ]) {
    assert.equal(hasCareerMetricTerm(question), true, `띄어쓰기 변이 미인식: ${question}`);
    assert.equal(routeQuestion(question, [], PLAYERS), "history_hold", question);
  }
});

// ⚠️ 2026-08-12 하린아빠 A안 — **다의어 과차단은 의도적으로 수용한다.**
// 표현으로 "그 어휘가 지표로 쓰였나" 를 가르는 것은 열린 자연어 판정이고, 실측으로 한쪽을
// 막으면 반대쪽이 열렸다(뒤결합 화이트리스트 → 누수 149/288). 두 리스크는 대칭이 아니다:
//   누수 = 봇이 틀린 이름을 확신해서 말한다(거짓) / 과차단 = "아직 준비되지 않았어요"(거짓 아님).
// 그래서 아래 문장들이 hold 안내문을 받는 것을 **계약으로 고정**한다. 되돌리려면 표현 룰이
// 아니라 답변 단계 실명 근거 게이트(후속 PR)로 해결한다 — 이 앵커가 그 결정의 기록이다.
check("P0(A안): 다의어가 지표 아닌 뜻으로 쓰인 문장의 과차단은 수용된 계약이다", () => {
  for (const question of [
    "역대 최고의 득점 장면",     // 삼순 1차 exact
    "역대 최고의 보살은?",       // 삼순 1차 exact
    "역대 최고의 실책 순간",
  ]) {
    assert.equal(
      routeQuestion(question, [], PLAYERS), "history_hold",
      `A안 계약이 깨졌다(누수 축으로 되돌아갔을 가능성): ${question}`,
    );
  }
});

check("P0: 반대편 과차단 0 — 지표 어휘 없는 서술·주관은 LLM 범위 판정", () => {
  for (const question of [
    "역대 최고의 타자는 누구야?",
    "역대 가장 멋진 선수 누구야?",
    "역대 최고의 경기 알려줘",
    "커리어 선발로 가장 기억나는 경기는?",
    "누적 피로가 많으면 구속이 떨어져?",
    "커리어가 긴 투수는 부상이 많아?",
    "역대 최고 인기 구단 어디야?",
    "통산이 뭐야?",
  ]) {
    assert.equal(routeQuestion(question, [], PLAYERS), "llm_scope_gate", question);
  }
});

check("P0: 일반명사 공식 컬럼(`경기`·`선발`)은 판정 어휘로 승격되지 않는다", () => {
  // 승격되면 위 서술·주관 축이 통째로 hold 로 끌려온다(#1159 10차 P0와 같은 축).
  assert.ok(KBO_OFFICIAL_GENERAL_TERMS.includes("경기"));
  assert.ok(KBO_OFFICIAL_GENERAL_TERMS.includes("선발"));
  const overlap = KBO_OFFICIAL_GENERAL_TERMS.filter((w) => KBO_OFFICIAL_METRIC_TERMS.includes(w));
  assert.deepEqual(overlap, [], `일반명사가 판정 어휘에 섞였다: ${overlap.join(", ")}`);
  // 같은 컬럼은 비일반 공식 표기로 여전히 닫힌다.
  for (const question of ["통산 경기수 1위 누구야?", "통산 선발등판 1위 누구야?"]) {
    assert.equal(routeQuestion(question, [], PLAYERS), "history_hold", question);
  }
});

check("P0: 판정 어휘 = 감사 문서 expected-set (missing/extra 0, 독립 근거)", () => {
  const { expected, rowCount, doc } = parseExpectedColumns(REPO_ROOT);
  assert.equal(rowCount, 10, `${doc} 컬럼 표 행 수가 변했다`);
  // ⚠️ 규모를 상수로 못 박는다(삼순 #1164 1차 지적 — 보고가 71개였으나 실측 75개였다).
  // 이 숫자가 바뀌면 보고문도 함께 고쳐야 한다는 신호다.
  const columnCount = new Set(KBO_OFFICIAL_METRIC_COLUMNS.map((c) => `${c.source}:${c.code}`)).size;
  assert.equal(columnCount, 75, `공식 컬럼 (source,code) 수가 변했다: ${columnCount}`);
  assert.equal(KBO_OFFICIAL_METRIC_TERMS.length, 96, `판정 어휘 수가 변했다: ${KBO_OFFICIAL_METRIC_TERMS.length}`);
  const actual = new Set(KBO_OFFICIAL_METRIC_COLUMNS.map((c) => `${c.source}:${c.code}`));
  const missing = [...expected].filter((key) => !actual.has(key)).sort();
  const extra = [...actual].filter((key) => !expected.has(key)).sort();
  assert.deepEqual(missing, [], `공식 컬럼 누락: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `감사 문서에 없는 컬럼: ${extra.join(", ")}`);
});

check("P0: 공식 컬럼 제외 통로 0 (completeness 우회 금지)", () => {
  assert.equal(DOCUMENTED_EXCLUSIONS.size, 0, "공식 컬럼을 임의 제외했다");
  assert.equal(DERIVED_RATIO.size, 0, "파생 비율이라며 공식 컬럼을 제외했다");
});

check("P0: inventory 전 컬럼이 판정까지 도달한다 (등재-판정 괴리 0)", () => {
  for (const column of KBO_OFFICIAL_METRIC_COLUMNS) {
    for (const term of column.terms) {
      assert.equal(
        hasCareerMetricTerm(`통산 ${term} 1위 누구야?`), true,
        `${column.code}/${term} 미결속`,
      );
    }
  }
});

check("P0: 팀 한정 통산·역대도 어휘 전수 fail-close (`!hasTeam` 제거 결속)", () => {
  const leaks: string[] = [];
  for (const term of KBO_OFFICIAL_METRIC_TERMS) {
    for (const form of CAREER_TEAM_ASK_FORMS) {
      const question = form(term);
      const route = routeQuestion(question, [], PLAYERS);
      if (route !== "history_hold") leaks.push(`${question} -> ${route}`);
    }
  }
  assert.deepEqual(
    leaks, [],
    `팀 한정 통산 질문 ${leaks.length}건이 fail-close 되지 않는다:\n  ${leaks.slice(0, 12).join("\n  ")}`,
  );
});

check("P0: 선수 지목·팀선수 복합 통산도 어휘 전수 fail-close", () => {
  const leaks: string[] = [];
  for (const term of KBO_OFFICIAL_METRIC_TERMS) {
    for (const form of CAREER_PLAYER_ASK_FORMS) {
      const question = form(term);
      const route = routeQuestion(question, [], PLAYERS);
      if (route !== "history_hold") leaks.push(`${question} -> ${route}`);
    }
  }
  assert.deepEqual(
    leaks, [],
    `선수 지목 통산 질문 ${leaks.length}건이 fail-close 되지 않는다:\n  ${leaks.slice(0, 12).join("\n  ")}`,
  );
});

check("무회귀: 선수 **당해 시즌** 수치·서술은 그대로다", () => {
  // 통산·역대 표지가 없으면 이 분기에 들어오지 않는다.
  assert.equal(routeQuestion("김도영 홈런 몇 개야?", [], PLAYERS), "history_hold");
  assert.equal(routeQuestion("최형우 타율 얼마야?", [], PLAYERS), "history_hold");
  assert.equal(routeQuestion("김도영 누구야?", [], PLAYERS), "llm_scope_gate");
});

check("무회귀: 구단 **당해 시즌** 수치는 여전히 team 축이 처리한다", () => {
  // `!hasTeam` 제거가 구단 축을 삼키면 안 된다. 통산·역대 표지가 없는 구단 수치는 그대로다.
  for (const question of ["LG 팀타율 얼마야?", "기아 홈런 몇 개야?", "두산 순위 어때?"]) {
    assert.equal(routeQuestion(question, [], PLAYERS), "team_record", question);
  }
  // 구단 서술·평가도 그대로 LLM 범위 판정이다(과차단 회귀 방지).
  for (const question of ["삼성 라이온즈 홈런 잘 치는 팀이야?", "LG 주장 누구야?"]) {
    assert.equal(routeQuestion(question, [], PLAYERS), "llm_scope_gate", question);
  }
});

check("무회귀: 요청 형태 판정(`isCareerLeaderboardAsk`)은 main 구현 그대로다", () => {
  // 이 PR 은 **지표 축**만 넓힌다. 요청 형태 축(열린 언어)은 건드리지 않는다.
  const mainScope = /통산|역대|올타임/;
  const mainAsk = /1\s*위|누구|누가|최다|최고/;
  const mainImpl = (question: string): boolean => {
    const normalized = question.normalize("NFKC").toLowerCase();
    return mainScope.test(normalized) && mainAsk.test(normalized);
  };
  for (const question of [
    "통산 탈삼진 1위 누구야?",
    "통산 끝내기 상위 10명",
    "통산 폭투 제일 많은 선수",
    "역대 견제사 누가 많아?",
    "역대 최고의 타자는 누구야?",
    "지금 홈런 1위 누구야?",
  ]) {
    assert.equal(
      isCareerLeaderboardAsk(question), mainImpl(question),
      `요청 형태 판정이 main 과 갈라졌다: ${question}`,
    );
  }
});

check("무회귀: 기존 경로 (선수 지목·구단 수치·당해 시즌)", () => {
  assert.equal(routeQuestion("김도영 홈런 몇 개야?", [], PLAYERS), "history_hold");
  assert.equal(routeQuestion("LG 팀타율 얼마야?", [], PLAYERS), "team_record");
  assert.equal(routeQuestion("지금 홈런 1위 누구야?", [], PLAYERS), "blocked");
});

// ─────────────────────────────────────────────────────────────────────────────
// 종단 검증 (`answerQuestion`) — 라우터만 보면 production 을 증명하지 못한다.
//
// ⚠️ 삼순 #1164 5차 P0. 이 게이트는 `routeQuestion()` 만 검사했는데, production 의
// `answerQuestion()` 은 **선수가 결속되면 route 를 `baseball_rule_term` 으로 덮어** 이 분기를
// 건너가고, `fetchCareerRecord` 도 배선돼 있다. 그래서 `최형우 통산 타율 얼마야?` 는 라우터에서
// hold 로 보이지만 종단에서는 `kbo_structured` **실답**이다. 나는 라우터 결과만 보고 주석에
// "선수 지목 통산은 조회 배선 없음 / 전부 hold" 라고 반대로 적었다 — 실측하지 않은 단정이었다.
//
// 그래서 두 계약을 종단에서 각각 고정한다:
//   ⓐ 지원 지표(career-series 컬럼)의 구조화 실답은 **보존**된다.
//   ⓑ 미지원 공식 지표는 llm / rag / cache / dictionary 로 **가지 않는다**(누수 0).
const CAREER_FIXTURE = readFileSync(
  path.join(REPO_ROOT, "scripts/qa/fixtures/kbo-career-batter.html"),
  "utf-8",
);
/** 생성·검색 경로 — 미지원 지표가 여기 닿으면 누수다. */
const GENERATIVE_SOURCES = ["llm", "rag", "team_rag", "news_rag", "cache", "dictionary"];

function e2eDeps(): QaDeps {
  let stored: unknown = null;
  let started = false;
  return {
    loadGlossary: async () => [],
    loadPlayers: async () => PLAYERS,
    getCache: async () => null,
    setCache: async () => {},
    // LLM 이 불리면 그 자체가 누수다. 불렸는지 알 수 있도록 정상 응답을 준다.
    callLlm: async () => ({
      text: JSON.stringify({ status: "OK", answer: "최형우가 1위입니다" }),
      inputTokens: 1,
      outputTokens: 1,
    }),
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async () => {},
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => {
      started = true;
      return true;
    },
    storeLlm: async (r: unknown) => {
      stored = r;
    },
    fetchSeasonRecord: async () => [],
    enablePlayerRag: true,
    searchRag: async () => [],
    callRagLlm: async () => ({ text: "{}", inputTokens: 1, outputTokens: 1 }),
    // production 과 동일하게 배선한다 — 미배선으로 두면 ⓐ 를 증명할 수 없다.
    fetchCareerRecord: createCareerRecordFetcher(async () => CAREER_FIXTURE, () => Date.UTC(2026, 7, 10)),
  } as unknown as QaDeps;
}

const asyncChecks: Array<[string, () => Promise<void>]> = [];
function checkAsync(name: string, fn: () => Promise<void>): void {
  asyncChecks.push([name, fn]);
}

checkAsync("P0(종단): 값 질문의 구조화 실답이 보존된다 (kbo_structured)", async () => {
  // 이 PR 이 실답을 빼앗지 않는다는 계약. **값을 묻는 형태**만 실답 대상이다.
  for (const question of [
    "최형우 통산 타율 얼마야?",   // 삼순 5차 exact
    "최형우 통산 홈런 몇 개야?",
    "최형우 통산 안타 몇 개야?",
    "최형우의 연도별 타율 추이가 어떻게 돼?",
    "최형우 작년 타율 얼마였어?",
  ]) {
    const result = await answerQuestion("u1", question, e2eDeps());
    assert.equal(result.source, "kbo_structured", `${question} -> ${result.source} :: ${result.answer}`);
  }
});

checkAsync("P0(종단): 리더보드 질문에 개인값을 렌더하지 않는다 (오답 변환 금지)", async () => {
  // ⚠️ 삼순 #1164 5차 P0 exact. `최형우 통산 홈런 1위야?` 는 "1위인가" 를 물었는데
  // 개인 통산값(431)을 `kbo_structured` 로 내보냈다 — 질문에 답하지 않은 오답 변환이다.
  // 순위 확정에는 리그 전체 통산 순위표가 필요하고 그 정본이 아직 없으므로 hold 다.
  for (const question of [
    "최형우 통산 홈런 1위야?",     // 삼순 exact
    "최형우 통산 타율 1위야?",
    "최형우 역대 안타 최다 맞아?",
    "김도영 통산 도루 1위야?",
  ]) {
    const result = await answerQuestion("u1", question, e2eDeps());
    assert.notEqual(
      result.source, "kbo_structured",
      `리더보드 질문에 개인값을 렌더했다: ${question} :: ${result.answer}`,
    );
    assert.ok(
      !/\d/.test(result.answer.replace(/2026|\d+\s*시즌/g, "")),
      `순위 답에 수치가 섞였다: ${question} :: ${result.answer}`,
    );
  }
});

checkAsync("P0(종단): 리더보드 형태 × 공식 어휘 전수 — kbo_structured·생성경로 0", async () => {
  // ⚠️ 종전 이 전수는 지원 지표 9개를 **제외**해서 false-green 이었다(삼순 5차 P0).
  // 지금은 전 어휘를 태우고, 금지 목록에 `kbo_structured` 까지 넣는다 — 리더보드 질문에
  // 개인값을 렌더하는 것도 누수로 센다.
  const forms: Array<(term: string) => string> = [
    (term) => `통산 ${term} 1위 누구야?`,
    (term) => `LG 통산 ${term} 1위 누구야?`,
    (term) => `최형우 통산 ${term} 1위야?`,
    (term) => `LG 김도영 통산 ${term} 최다 맞아?`,
  ];
  const forbidden = [...GENERATIVE_SOURCES, "kbo_structured"];
  const leaks: string[] = [];
  let checked = 0;
  for (const term of KBO_OFFICIAL_METRIC_TERMS) {
    for (const form of forms) {
      const question = form(term);
      checked += 1;
      const result = await answerQuestion("u1", question, e2eDeps());
      if (forbidden.includes(result.source)) leaks.push(`${question} -> ${result.source}`);
    }
  }
  console.log(`     종단 전수 ${forms.length}형태 × ${KBO_OFFICIAL_METRIC_TERMS.length}어휘 = ${checked} / 누수 ${leaks.length}`);
  assert.equal(checked, forms.length * KBO_OFFICIAL_METRIC_TERMS.length);
  assert.deepEqual(
    leaks, [],
    `리더보드 질문 ${leaks.length}건이 금지 경로로 샌다:\n  ${leaks.slice(0, 12).join("\n  ")}`,
  );
});

checkAsync("P0(종단): 미지원 지표 안내문은 hold 문구다 (숫자·이름 단정 없음)", async () => {
  for (const question of [
    "통산 견제사 1위 누구야?",
    "최형우 통산 폭투 1위야?",
    "LG 통산 주루사 1위 누구야?",
  ]) {
    const result = await answerQuestion("u1", question, e2eDeps());
    assert.equal(result.source, "history_hold", `${question} -> ${result.source}`);
    // LLM mock 이 준 이름 단답이 새어나오지 않았음을 직접 확인한다.
    assert.ok(
      !result.answer.includes("1위입니다"),
      `LLM 단답이 새어나왔다: ${question} :: ${result.answer}`,
    );
  }
});

async function runAsyncChecks(): Promise<void> {
  for (const [name, fn] of asyncChecks) {
    try {
      await fn();
      pass += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name} :: ${message}`);
      console.error(`FAIL ${name} :: ${message}`);
    }
  }
  console.log(`\ngenius career metric leak: PASS=${pass} FAIL=${failures.length}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} FAIL:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}

void runAsyncChecks();
