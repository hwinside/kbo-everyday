#!/usr/bin/env node
/**
 * `qa:stat-clarify-misfire` 검출력 증명 — 실제 배포 소스를 한 축씩 훼손하고
 * 게이트가 RED 인지 확인한 뒤 반드시 원복한다.
 *
 * ⚠️ 계약 4가지 (2026-08-22 lessons `게이트를 쓴 직후 4개를 스스로 묻는다`):
 *   ① 각 mutation 은 **실제 RED 를 낼 수 있는 경로**를 훼손한다.
 *   ② 판정 키는 실패 줄에만 나오는 안정 ID `[SCM-FAIL]` 이다 — 통과 출력(✅)과 겹치지 않는다.
 *   ③ **패치 미적용은 PASS 가 아니라 FAIL** 이다(anchor MISS = 검증력 0).
 *   ④ 태우는 경로는 게이트가 실제로 import 하는 production seam 이다.
 *
 * ⚠️ mutant 끼리 **동치가 아닌지** 확인했다 — M1(숫자 head 가드 제거)과 M4(정규식 완화)는
 *   같은 축을 다른 지점에서 훼손하지만, M4 는 숫자 head 검사를 남긴 채 head 후보 자체를
 *   바꾸므로 다른 실패 문구를 낸다.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const PROMPT = "src/lib/baseball-qa/gemini-request.ts";
const TARGETS = [PIPELINE, PROMPT];

const originals = new Map(TARGETS.map((f) => [f, fs.readFileSync(f, "utf8")]));
const restore = () => {
  for (const [f, src] of originals) fs.writeFileSync(f, src);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restore(); process.exit(130); });
}

/**
 * mutation 은 **구조/정규식**으로 재타깃한다 — 문자열 정확일치는 주석 한 글자만 바뀌어도
 * 조용히 no-op 이 되고 mutant==원본 이라 false-GREEN 이 난다(2026-08-22 실측).
 */
const mutations = [
  {
    name: "M1 숫자 head 가드 제거 (수정 ① 무력화)",
    file: PIPELINE,
    re: /if \(\/\^\[0-9\]\/u\.test\(head\)\) return "none";/,
    to: 'if (false) return "none";',
    why: "31호·4점차면·3루카 가 다시 미결속이 되어 되묻기로 종결",
  },
  {
    name: "M2 RULE_TERM 토큰 파싱 제거 (수정 ② 무력화)",
    file: PIPELINE,
    re: /if \(token === "RULE_TERM"\) return "rule_term";/,
    to: "",
    why: "룰 질문 신호를 다시 버려 되묻기 fail-close",
  },
  {
    name: "M3 RULE_TERM 재질의 분기 제거",
    file: PIPELINE,
    re: /if \(intent === "rule_term"\) \{/,
    to: "if (false) {",
    why: "토큰은 파싱되지만 재질의를 안 해 답이 안 나감",
  },
  {
    name: "M4 재질의를 가드 모드로 보냄 (일반 프롬프트 결속 훼손)",
    file: PIPELINE,
    re: /reasked = await deps\.callLlm\(question, context \?\? undefined, rosterBlock, false\);/,
    to: "reasked = await deps.callLlm(question, context ?? undefined, rosterBlock, true);",
    why: "재질의가 다시 토큰 프롬프트로 가면 정상 답변을 못 받는다",
  },
  {
    name: "M5 재질의 답 검증 우회 (validateLlmResponse 생략)",
    file: PIPELINE,
    re: /const revalidated = validateLlmResponse\(reasked\.text, question\);/,
    to: 'const revalidated = { kind: "answer", answer: reasked.text } as ReturnType<typeof validateLlmResponse>;',
    why: "검증 없이 원문을 서빙하면 D5(검증 실패→되묻기) 축이 깨진다",
  },
  {
    name: "M6 재질의 답을 캐시에 씀 (가드 소유 non-cacheable 계약 위반)",
    file: PIPELINE,
    re: /(return \{ status: 200, answer: revalidated\.answer, source: "llm", remaining \};)/,
    to: 'await deps.setCache(questionNorm, revalidated.answer);\n          $1',
    why: "가드 소유 답이 global cache 로 새면 D6 이 잡아야 한다",
  },
  {
    name: "M7 프롬프트에서 RULE_TERM 지시 삭제",
    file: PROMPT,
    re: /"RULE_TERM — 특정 대상의 값이 아니라 [^"]*",/,
    to: "",
    why: "코드는 토큰을 받지만 LLM 은 그 토큰을 낼 이유가 없다 — 계약 문서화 이탈",
  },
  {
    name: "M8 되묻기 fail-close 를 자유문장 서빙으로 교체",
    file: PIPELINE,
    re: /const final: StoredQaFinal = intent === "narrative"/,
    to: 'const final: StoredQaFinal = intent === null\n      ? { answer: "임의 자유문장", source: "llm" }\n      : intent === "narrative"',
    why: "자유문장 서빙 0 계약(D4)이 깨진다",
  },
  {
    name: "M9 제품 기능 결합형 폐쇄집합 비움 (2026-08-23 배포 후 QA 수정 무력화)",
    file: PIPELINE,
    re: /const PRODUCT_FEATURE_COMPOUNDS: ReadonlySet<string> = new Set\(\[[\s\S]*?\]\);/,
    to: "const PRODUCT_FEATURE_COMPOUNDS: ReadonlySet<string> = new Set<string>([]);",
    why: "`직관 기록`(정규화 산출물)이 다시 미결속이 되어 되묻기로 종결 — 프로덕션 3/3 재현 축",
  },
  {
    name: "M10 결합형 판정을 head 단독 판정으로 교체 (다의어 과확장 방향)",
    file: PIPELINE,
    re: /if \(PRODUCT_FEATURE_COMPOUNDS\.has\(combined\.toLowerCase\(\)\)\) return "term_question";/,
    to: 'if (PRODUCT_FEATURE_COMPOUNDS.has(head.toLowerCase())) return "term_question";',
    why: "결합형 exact 계약이 깨져 `직관 기록` 이 다시 미결속 — 동시에 head 단독 승격은 C6 다의어 축이 잡는다",
  },
  {
    name: "M11 정규화 seam 결과를 버리고 원문으로 진행 (full seam 무력화)",
    file: PIPELINE,
    re: /\n    if \(accepted\) \{\n      question = candidate;\n      questionNorm = normalizeQuestion\(candidate\);/,
    to: "\n    if (false) {\n      question = candidate;\n      questionNorm = normalizeQuestion(candidate);",
    why: "정규화가 수용돼도 재라우팅이 안 일어난다 — B2 full seam 축(로그 필드·최종 source)이 잡아야 한다",
  },
];

let failed = 0;
for (const m of mutations) {
  const source = originals.get(m.file);
  if (!m.re.test(source)) {
    console.log(`❌ [MUT-ANCHOR-MISS] ${m.name} — 앵커 불일치, 패치 미적용은 PASS 가 아니다`);
    failed += 1;
    continue;
  }
  const mutated = source.replace(m.re, m.to);
  if (mutated === source) {
    console.log(`❌ [MUT-NOOP] ${m.name} — 치환이 no-op (mutant == 원본)`);
    failed += 1;
    continue;
  }
  fs.writeFileSync(m.file, mutated);
  const run = spawnSync("npx", ["tsx", "scripts/qa/stat-clarify-misfire-gate.ts"], {
    encoding: "utf8",
    env: process.env,
  });
  restore();
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  // ⚠️ 판정 키는 실패 줄 전용 안정 ID 다 — 통과 출력에는 절대 나타나지 않는다.
  const red = run.status !== 0 && /\[SCM-FAIL\]|\[MUT-/.test(out);
  if (red) {
    console.log(`✅ ${m.name} → RED (${m.why})`);
  } else {
    console.log(`❌ [MUT-GREEN] ${m.name} → 게이트가 못 잡음 (exit=${run.status})`);
    console.log(out.split("\n").filter((l) => l.includes("❌") || l.includes("총 ")).join("\n"));
    failed += 1;
  }
}

restore();
// 원복 검증 — 게이트가 소스를 오염된 채 남기면 이후 모든 판정이 무효다.
for (const [f, src] of originals) {
  if (fs.readFileSync(f, "utf8") !== src) {
    console.log(`❌ [MUT-DIRTY] ${f} 원복 실패`);
    failed += 1;
  }
}

console.log(`\nmutations ${mutations.length} · 미검출 ${failed}`);
if (failed > 0) process.exit(1);
console.log("✅ 검출력 증명 완료 — 모든 축에서 RED");
