#!/usr/bin/env node
/**
 * 질문 1차 LLM 정규화 — mutation 게이트.
 *
 * 각 가드를 결함주입으로 죽였을 때 smoke(genius-question-normalize-smoke.ts)가 RED 가 되는지
 * 증명한다. 규칙:
 *  · 주입은 성공 여부를 매 케이스 확인한다 — 패턴 미발견=미실행이지 통과가 아니다
 *    (lesson: mutation_injection_silently_failed).
 *  · RED 판정은 assertion 실패만 인정한다 — 컴파일/모듈 오류의 nonzero 는 검출이 아니다
 *    (2026-08-09 #1137 lesson: 아무 nonzero 를 RED 로 세면 죽은 러너도 GREEN 으로 보인다).
 *  · 원복은 백업 복사로 한다 — git checkout 금지 (P0).
 *
 * 실행: npm run qa:genius-question-normalize:mutations
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const target = path.join(root, "src/lib/baseball-qa/pipeline.ts");
const backup = `${target}.qnorm-mutations.bak`;

const mutations = [
  {
    name: "M1 발동 라우트 조건 제거 (모든 라우트에서 발동)",
    find: 'routeQuestion(question, glossary, players, false) === "llm_scope_gate"',
    replace: 'routeQuestion(question, glossary, players, false) !== "__never__"',
  },
  {
    name: "M2 숫자 시퀀스 보존 가드 제거",
    find: "if (!digitSequencesMatch(question, candidate)) return rejected;",
    replace: "if (false) return rejected;",
  },
  {
    name: "M3 재라우팅 blocked 가드 제거",
    find: 'if (routeQuestion(candidate, glossary, players, false) === "blocked") return rejected;',
    replace: "if (false) return rejected;",
  },
  {
    name: "M4 실변경(raw 비교) 가드 제거",
    find: "if (candidate === question) return rejected;",
    replace: "if (false) return rejected;",
  },
  {
    name: "M5 fail-open 제거 (정규화 장애가 답변을 죽임)",
    find: "norm = null; // 정규화 장애는 원문 진행",
    replace: 'throw new Error("normalizer failure leaks"); //',
  },
  {
    name: "M6 로그 원문 고정 제거 (정규화문이 question 을 덮어씀)",
    find: "question: originalQuestion,\n          questionNormalized: acceptedText,",
    replace: "questionNormalized: acceptedText,",
  },
  {
    name: "M7 길이 상한 가드 제거",
    find: "if (candidate.length > question.length * 2 + 10) return rejected;",
    replace: "if (false) return rejected;",
  },
  {
    name: "M8 Tier B HOLD 제거 (폐쇄집합 내부 용어 치환 통과)",
    find: "return rejected; // Tier B 자동 재라우팅 HOLD — 폐쇄집합 착지만으로 의미 불변을 증명할 수 없다.",
    replace: 'return { accepted: true, status: "accepted_surface" };',
  },
  {
    name: "M9 관측 status 기록 제거 (미호출/거절/오류 구분 소실)",
    find: "normalizeStatus: normStatus,",
    replace: "",
  },
  {
    name: "M10 Tier A 조건 완화 (문자 구성이 달라도 surface 수용 — Tier B HOLD 우회)",
    find: 'if (normalizeKey(candidate) === normalizeKey(question)) {\n    return { accepted: true, status: "accepted_surface" };\n  }',
    replace: 'if (true) {\n    return { accepted: true, status: "accepted_surface" };\n  }',
  },
];

function runSmoke() {
  try {
    execFileSync("npx", ["tsx", "scripts/qa/genius-question-normalize-smoke.ts"], {
      cwd: root,
      stdio: "pipe",
      timeout: 120_000,
    });
    return { code: 0, output: "" };
  } catch (err) {
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    return { code: err.status ?? 1, output };
  }
}

// 전제: 무변이 상태에서 smoke 는 GREEN 이어야 한다 — 아니면 mutation 판정 자체가 무의미하다.
{
  const base = runSmoke();
  if (base.code !== 0) {
    console.error("BASELINE RED — 무변이 smoke 가 이미 실패한다. mutation 판정 불가.");
    console.error(base.output.slice(0, 2000));
    process.exit(1);
  }
}

const original = readFileSync(target, "utf8");
copyFileSync(target, backup);
let failures = 0;

try {
  for (const m of mutations) {
    if (!original.includes(m.find)) {
      console.error(`INJECTION FAILED (pattern not found): ${m.name}`);
      failures++;
      continue;
    }
    const occurrences = original.split(m.find).length - 1;
    if (occurrences !== 1) {
      console.error(`INJECTION AMBIGUOUS (${occurrences} occurrences): ${m.name}`);
      failures++;
      continue;
    }
    writeFileSync(target, original.replace(m.find, m.replace));
    const res = runSmoke();
    const assertionFailure = /AssertionError|ERR_ASSERTION|normalizer failure leaks/.test(res.output);
    if (res.code !== 0 && assertionFailure) {
      console.log(`RED (검출 성공): ${m.name}`);
    } else if (res.code !== 0) {
      console.error(`NONZERO BUT NOT ASSERTION (러너/컴파일 오류 의심): ${m.name}`);
      console.error(res.output.slice(0, 1200));
      failures++;
    } else {
      console.error(`GREEN (검출 실패 — 가드가 죽어도 게이트가 통과): ${m.name}`);
      failures++;
    }
    copyFileSync(backup, target);
  }
} finally {
  copyFileSync(backup, target);
  rmSync(backup, { force: true });
}

if (failures > 0) {
  console.error(`mutation 게이트 실패: ${failures}건`);
  process.exit(1);
}
console.log(`genius-question-normalize-mutations: ${mutations.length}/${mutations.length} RED`);
