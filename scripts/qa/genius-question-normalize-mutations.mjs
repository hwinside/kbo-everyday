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
    name: "M1 발동 라우트 조건 제거",
    find: 'routeQuestion(question, glossary, players, false) === "llm_scope_gate"',
    replace: 'routeQuestion(question, glossary, players, false) !== "__never__"',
  },
  {
    name: "M2 숫자 시퀀스 보존 제거",
    find: 'if (!digitSequencesMatch(question, candidate)) return "rejected";',
    replace: 'if (false) return "rejected";',
  },
  {
    // 삼순 2026-08-13 ②: 착지 allowlist 를 "blocked/residual 만 제외" 로 되돌리면
    // ack·history_hold 같은 답 못 하는 라우트 후보까지 제안된다.
    name: "M3 착지 allowlist 를 non-blocked 로 완화",
    find: 'return CORRECTION_SUGGESTABLE_ROUTES.includes(candidateRoute) ? "suggest" : "rejected";',
    replace: 'return candidateRoute !== "llm_scope_gate" ? "suggest" : "rejected";',
  },
  {
    // allowlist 자체를 넓혀도 같은 사고가 난다 — 상수 목록도 계약이다.
    name: "M3b allowlist 에 답 못 하는 라우트 추가",
    find: '  "career_leaderboard",\n];',
    replace: '  "career_leaderboard",\n  "ack",\n  "history_hold",\n];',
  },
  {
    // 삼순 ③ 취소 종결: 거절을 무시하면 정규화가 다시 돌아 같은 제안이 무한 반복된다.
    name: "M9 거절 플래그를 무시하고 정규화 재진입",
    find: 'if (!deps.pickedNormalizedQuestion && !deps.correctionDeclined && deps.normalizeQuestionLlm',
    replace: 'if (!deps.pickedNormalizedQuestion && deps.normalizeQuestionLlm',
  },
  {
    // 삼순 ③ 관측 분리: 제안문을 수용문 칸에 섮으면 오교정 감사 분모가 깨진다.
    name: "M10 제안 후보를 수용문 칸에 섮음",
    find: 'const acceptedText = accepted ? candidate : null;',
    replace: 'const acceptedText = accepted || suggested ? candidate : null;',
  },
  {
    name: "M11 제안 전용 관측 칸 기록 제거",
    find: 'correctionCandidate: suggestedText,',
    replace: '',
  },
  {
    name: "M4 선택 전 Tier B 자동수용",
    find: 'accepted = verdict === "accepted_surface";',
    replace: 'accepted = verdict === "accepted_surface" || verdict === "suggest";',
  },
  {
    name: "M5 선택 적용 시 membership 재검증 제거",
    find: 'if (classifyQuestionCorrectionCandidate(question, picked, glossary, players) !== "suggest") {',
    replace: 'if (false) {',
  },
  {
    name: "M6 유저 선택 후보 적용 제거",
    find: 'question = picked;\n    questionNorm = normalizeQuestion(picked);',
    replace: 'question = originalQuestion;\n    questionNorm = normalizeQuestion(originalQuestion);',
  },
  {
    name: "M7 로그 원문 고정 제거",
    find: `question: originalQuestion,\n          questionNormalized: acceptedText,`,
    replace: 'questionNormalized: acceptedText,',
  },
  {
    name: "M8 관측 status 제거",
    find: 'normalizeStatus: normStatus,',
    replace: '',
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
