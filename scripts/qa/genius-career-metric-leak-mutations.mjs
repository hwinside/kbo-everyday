#!/usr/bin/env node
/**
 * `genius-career-metric-leak` 게이트의 **검출력 증명**.
 *
 * 각 축을 실제로 망가뜨렸을 때 게이트가 RED 가 되는지 확인한다. RED 가 안 나오면
 * 그 축은 게이트가 아니라 장식이다(#1159 에서 검출력 0 mutation 을 여러 번 실측했다).
 * 파일 복원은 `git checkout` 을 쓰지 않는다 — 다른 세션의 변경을 날릴 수 있다(P0).
 * 백업 복사 후 되돌린다.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const INVENTORY = "src/lib/baseball-qa/stats/kbo-official-metric-columns.ts";
const EXPECTED_PARSER = "scripts/qa/kbo-metric-inventory-expected.mjs";
const SMOKE = "scripts/qa/genius-career-metric-leak-smoke.ts";

const MUTATIONS = [
  {
    name: "m1 지표 축을 옛 STAT_WORDS 로 회귀 — 공식 지표 다수가 generic LLM 으로 샌다",
    file: PIPELINE,
    from: "    hasCareerMetricTerm(question) &&",
    to: "    hasStat &&",
  },
  {
    name: "m2 지표 축 판정 무력화 (항상 false) — 통산 질문 전량 누수",
    file: PIPELINE,
    from: "  return KBO_OFFICIAL_METRIC_TERMS.some((term) => normalized.includes(term));",
    to: "  return false;",
  },
  {
    name: "m3 지표 축 판정 과확대 (항상 true) — 서술·주관 질문까지 hold 로 과차단",
    file: PIPELINE,
    from: "export function hasCareerMetricTerm(question: string): boolean {",
    to: "export function hasCareerMetricTerm(question: string): boolean {\n  if (question) return true;",
  },
  {
    name: "m4 공백 정규화 제거 — `통산 탈 삼진 1위` 류 띄어쓰기 변이가 샌다",
    file: PIPELINE,
    from: 'const normalized = question.normalize("NFKC").toLowerCase().replace(/\\s+/g, "");',
    to: 'const normalized = question.normalize("NFKC").toLowerCase();',
  },
  {
    name: "m4b(A안) 지표어 뒤결합 판정 재도입 — `역대 완봉승 1위` 등 실제 목표 자연어가 누락된다",
    file: PIPELINE,
    from: "  return KBO_OFFICIAL_METRIC_TERMS.some((term) => normalized.includes(term));",
    to: "  return KBO_OFFICIAL_METRIC_TERMS.some((term) => {\n    const at = normalized.indexOf(term);\n    if (at < 0) return false;\n    const tail = normalized.slice(at + term.length);\n    return /^(?:\\d+\\s*위|최다|최고|선두|순위|랭킹|누구|누가)/.test(tail);\n  });",
  },
  {
    name: "m4c `!hasTeam` 재도입 — `LG 통산 홈런 1위` 등 팀 한정 통산 질문이 샌다",
    file: PIPELINE,
    from: "    hasCareerMetricTerm(question) &&\n",
    to: "    hasCareerMetricTerm(question) &&\n    !hasTeam &&\n",
  },
  {
    name: "m4d `!hasPlayerReference` 재도입 — 선수 지목 통산 질문이 샌다",
    file: PIPELINE,
    from: "    isCareerLeaderboardAsk(question)\n  ) {",
    to: "    !hasPlayerReference(tokens, players) &&\n    isCareerLeaderboardAsk(question)\n  ) {",
  },
  {
    name: "m4e(종단) 선수 결속 route override 제거 — 지원 지표 구조화 실답이 hold 로 죽는다",
    file: PIPELINE,
    from: '  const route = enabledPlayerCandidate\n    ? "baseball_rule_term"\n    : routeQuestion(question, glossary, players, context !== null);',
    to: "  const route = routeQuestion(question, glossary, players, context !== null);",
  },
  {
    name: "m4f(종단) 리더보드 질문 개인값 가드 제거 — `최형우 통산 홈런 1위야?` 가 431 로 오답 변환",
    file: PIPELINE,
    from: '    if (isCareerLeaderboardAsk(question)) {\n      return settle(HISTORY_HOLD_ANSWER, "history_hold", "history_hold");\n    }',
    to: "",
  },
  {
    name: "m5 투수 공식 컬럼 삭제(`SO-pit=탈삼진`) — 실측 누수 어휘가 되살아난다",
    file: INVENTORY,
    from: '  { code: "SO-pit", source: "pitcher", terms: ["탈삼진"] },\n',
    to: "",
  },
  {
    name: "m6 주루 공식 컬럼 삭제(`PKO=견제사`)",
    file: INVENTORY,
    from: '  { code: "PKO", source: "runner", terms: ["견제사"] },\n',
    to: "",
  },
  {
    name: "m7 일반명사 컬럼을 판정 어휘로 승격(`경기`) — 서술·주관 질문 과차단",
    file: INVENTORY,
    from: '{ code: "G", source: "hitter", terms: ["경기수", "출장경기", "경기출장"], general: ["경기"] }',
    to: '{ code: "G", source: "hitter", terms: ["경기수", "출장경기", "경기출장", "경기"] }',
  },
  {
    name: "m8 expected-set 제외 통로 재도입 — completeness 우회",
    file: EXPECTED_PARSER,
    from: "export const DOCUMENTED_EXCLUSIONS = new Map([]);",
    to: 'export const DOCUMENTED_EXCLUSIONS = new Map([["Wgs", "통합"], ["Wgr", "통합"]]);',
  },
  {
    name: "m9 요청 형태 축을 main 과 다르게 확대 — 이 PR 범위 밖 변경",
    file: PIPELINE,
    from: "const CAREER_LEADERBOARD_ASK = /1\\s*위|누구|누가|최다|최고/;",
    to: "const CAREER_LEADERBOARD_ASK = /1\\s*위|누구|누가|최다|최고|많|상위/;",
  },
];

function runSmoke() {
  try {
    execFileSync("npx", ["tsx", SMOKE], { cwd: REPO_ROOT, stdio: "pipe" });
    return "GREEN";
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    // 컴파일 오류·모듈 로드 실패를 "검출 성공"으로 세면 안 된다 — 게이트가 실제 FAIL 을
    // 보고했을 때만 RED 로 인정한다(#1159 에서 실측한 false-RED 방지).
    return /FAIL=[1-9]|FAIL /.test(out) ? "RED" : `BROKEN:${out.slice(-200)}`;
  }
}

let red = 0;
const problems = [];
for (const mutation of MUTATIONS) {
  const target = path.join(REPO_ROOT, mutation.file);
  const backup = `${target}.mutbak`;
  const original = readFileSync(target, "utf8");
  if (!original.includes(mutation.from)) {
    problems.push(`MISS ${mutation.name} — 앵커 부재 (러너 고장)`);
    console.error(`MISS ${mutation.name} — 앵커 부재 (러너 고장)`);
    continue;
  }
  copyFileSync(target, backup);
  try {
    writeFileSync(target, original.replace(mutation.from, mutation.to), "utf8");
    const result = runSmoke();
    const expectRed = mutation.expectRed !== false;
    if (result === "RED" && expectRed) {
      red += 1;
      console.log(`RED  ${mutation.name}`);
    } else if (result === "GREEN" && !expectRed) {
      red += 1;
      console.log(`RED(설계상 GREEN 허용)  ${mutation.name}`);
    } else {
      problems.push(`${result} ${mutation.name}`);
      console.error(`${result} ${mutation.name}`);
    }
  } finally {
    copyFileSync(backup, target);
    unlinkSync(backup);
  }
}

console.log(`\nmutations: ${red}/${MUTATIONS.length} RED`);
if (problems.length > 0) {
  console.error(`\n${problems.length} 축 미검출:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
