/**
 * 리더보드·tier2 성의 게이트 검출력 증명 — 소스 결함주입 후 smoke RED 확인.
 * 계약: in-memory 백업 원복 / FAIL 마커만 RED 인정 / 앵커 부재 = 러너 고장 FAIL.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const RETRIEVE = "src/lib/baseball-qa/rag/retrieve.ts";
const GEMINI = "src/lib/baseball-qa/gemini-request.ts";

const MUTATIONS = [
  {
    name: "m1 리더보드 라우팅 제거 — 캡처 질문이 다시 차단으로 회귀",
    file: PIPELINE,
    from: "if (hasStat && !hasTeam && !hasPlayerReference(tokens, players) && isCareerLeaderboardAsk(question)) {\n    return \"llm_scope_gate\";\n  }",
    to: "",
  },
  {
    name: "m2 수치 기계 가드 제거 — 검증 불가 누적치가 그대로 발송",
    file: PIPELINE,
    from: "if (scopeGate && isCareerLeaderboardAsk(question) && !numericTokensSubsetOf(validated.answer, question)) {",
    to: "if (false) {",
  },
  {
    name: "m3 프롬프트 수치 금지 선언 제거",
    file: GEMINI,
    from: "\"통산·역대 순위 질문(통산 안타 1위 등)은 널리 알려진 선수 이름과 순위 관계만 답하고, 누적 기록 수치는 쓰지 않는다.\",",
    to: "",
  },
  {
    name: "m4 tier2 상한 160 회귀",
    file: RETRIEVE,
    from: "export const RAG_ANSWER_MAX_CHARS = 320;",
    to: "export const RAG_ANSWER_MAX_CHARS = 160;",
  },
  {
    name: "m6 인물 축 denylist 복원 — 우승 기여자 질문이 다시 차단",
    file: PIPELINE,
    from: "const OUT_OF_SCOPE_INTENT =\n  /추천|",
    to: "const OUT_OF_SCOPE_INTENT =\n  /누구|추천|",
  },
  {
    name: "m5 tier2 성의 지시 제거",
    file: RETRIEVE,
    from: "\"단순 사실 확인은 한두 문장으로 짧게, 이유·배경·사연을 묻는 질문은 자료 안의 맥락을 두세 문장으로 충분히 설명한다.\",",
    to: "",
  },
];

const backups = new Map();
let failures = 0;
try {
  for (const mutation of MUTATIONS) {
    const original = readFileSync(mutation.file, "utf-8");
    if (!original.includes(mutation.from)) {
      console.log(`FAIL(runner) ${mutation.name} :: 앵커 부재`);
      failures += 1;
      continue;
    }
    backups.set(mutation.file, original);
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
    let out = "";
    try {
      out = execFileSync("npx", ["tsx", "scripts/qa/baseball-qa-leaderboard-smoke.ts"], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000,
      });
    } catch (error) {
      out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    } finally {
      writeFileSync(mutation.file, original);
      backups.delete(mutation.file);
    }
    const red = /\nFAIL /.test(`\n${out}`) && out.includes("baseball QA leaderboard:");
    console.log(`${red ? "RED " : "MISS"} ${mutation.name}`);
    if (!red) failures += 1;
  }
} finally {
  for (const [file, original] of backups) writeFileSync(file, original);
}
console.log(failures === 0 ? `\n✅ mutations: ${MUTATIONS.length}/${MUTATIONS.length} RED` : `\n❌ ${failures} 축 미검출`);
process.exitCode = failures === 0 ? 0 : 1;
