#!/usr/bin/env tsx
/**
 * 통산·역대 리더보드 질문의 **generic LLM 누수 차단** 게이트.
 *
 * ⚠️ 왜 필요한가 (2026-08-12 실측).
 * 종전 라우팅은 이 축을 `STAT_WORDS`(13개)로 판정했다. KBO 공식 기록실 컬럼 71개로
 * `통산 <지표> 1위 누구야?` 를 전수 돌려보니 **52개가 `llm_scope_gate`로 샜다**
 * (`탈삼진`·`완봉`·`이닝`·`실책`·`선발승`·`견제사`…). 리더보드 답은 **이름 단답**이라
 * 숫자 환각 게이트에 걸리지 않는다 — 모델이 기억하는 옛 1위를 확신해서 내보낸다
 * (8/9 `임창규` 사고와 같은 축).
 *
 * 이 게이트가 지키는 것:
 *   ① 공식 컬럼 어휘 전수 × 통산 요청 형태 → generic LLM 도달 0
 *   ② 반대편 과차단 0 — 지표 어휘가 없는 서술·주관 질문은 그대로 LLM 범위 판정
 *   ③ 판정 어휘는 감사 문서 expected-set 과 missing/extra 0 (독립 근거 대조)
 *   ④ 기존 경로 무회귀 (선수 지목·구단 수치·당해 시즌)
 */
import assert from "node:assert/strict";
import path from "node:path";
import {
  hasCareerMetricTerm,
  isCareerLeaderboardAsk,
  routeQuestion,
  type QuestionRoute,
} from "../../src/lib/baseball-qa/pipeline";
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

check("P0: 공식 컬럼 어휘 × 통산 요청 형태 전수 — generic LLM 도달 0", () => {
  const leaks: string[] = [];
  for (const term of KBO_OFFICIAL_METRIC_TERMS) {
    for (const form of CAREER_ASK_FORMS) {
      const question = form(term);
      const route = routeQuestion(question, [], PLAYERS);
      if (LLM_ROUTES.includes(route)) leaks.push(`${question} -> ${route}`);
    }
  }
  assert.deepEqual(
    leaks, [],
    `공식 지표 ${leaks.length}건이 generic LLM 으로 샌다:\n  ${leaks.slice(0, 12).join("\n  ")}`,
  );
});

check("P0: 실측 누수 52건 대표 표본이 fail-close 된다", () => {
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

console.log(`\ngenius career metric leak: PASS=${pass} FAIL=${failures.length}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} FAIL:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
