/**
 * 질문 1차 LLM 정규화 — 실 provider 게이트.
 *
 * mock 주입 smoke(qa:genius-question-normalize)와 분리해, **배포되는 그 함수**
 * (`server.ts normalizeQuestionLlm` — 그 프롬프트·그 요청 빌더·그 파서)로 실제 Gemini 를
 * 호출해 교정 품질을 실측한다. 수용 판정도 파이프라인과 같은 가드
 * (digitSequencesMatch·normalizeKey 실변경·길이 상한)를 그대로 태운다.
 *
 * 계약:
 *  · 수용 판정은 배포 SSOT(`evaluateNormalizedCandidate`) 그대로 — production 사전·로스터를
 *    로드해 파이프라인과 같은 입력으로 판정한다. mustInclude 류 자체 재구현 판정은
 *    반대 의미·타 선수 추가를 못 잡는 false-green 이라 쓰지 않는다(삼순 1차 지적 축).
 *  · 양성 반복: 붙여쓰기 질문이 3회 연속 `accepted_surface`(문자 구성 동일 = 드리프트
 *    구조적 불가)로 수용된다.
 *  · 반대편: 이미 정상 표기인 질문은 SSOT 기준 미수용으로 수렴한다.
 *  · 숫자 포함 질문의 교정문은 숫자 시퀀스가 정확히 보존된다.
 *  · 키가 없으면 조용한 SKIP 이 아니라 명시적 실패(exit 1).
 *
 * 실행: npm run qa:genius-question-normalize-live (네트워크·GEMINI_API_KEY 필요, prebuild 밖)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 배포 env가 없을 때 로컬 .env.local에서만 주입한다(시크릿은 출력하지 않는다). */
function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(resolve(process.cwd(), ".env.local"));

async function main() {
  assert.ok(process.env.GEMINI_API_KEY, "GEMINI_API_KEY 필요 — 이 게이트는 SKIP 하지 않는다");
  // env 주입 후에 로드해야 server.ts 모듈 초기화가 산다.
  const { normalizeQuestionLlm, loadGlossary } = await import("../../src/lib/baseball-qa/server");
  const { loadRosterPlayers } = await import("../../src/lib/baseball-qa/roster/load-roster-players");
  const { digitSequencesMatch, evaluateNormalizedCandidate } = await import("../../src/lib/baseball-qa/pipeline");

  // 판정 입력을 파이프라인과 동일하게 — production 사전 + 배포 로스터 로더.
  const [glossary, players] = await Promise.all([loadGlossary(), loadRosterPlayers()]);
  assert.ok(glossary.length >= 100, `사전 로드 실패: ${glossary.length}`);
  assert.ok(players.length >= 500, `로스터 로드 실패: ${players.length}`);

  /** 배포 SSOT 판정 그대로 — 재구현 금지(검증기가 대상과 갈라지면 false-green). */
  function verdictOf(question: string, text: string | null) {
    const candidate = typeof text === "string" ? text.trim() : "";
    if (candidate.length === 0) return { accepted: false, status: "no_change" as const, candidate };
    const v = evaluateNormalizedCandidate(question, candidate, glossary, players);
    return { ...v, candidate };
  }

  let pass = 0;
  let fail = 0;
  const report: string[] = [];

  // ── 양성: 붙여쓰기 → accepted_surface 3회 연속 ────────────────────────────
  // surface 는 문자 구성 동일이라 "반대 의미·타 선수 추가" false-green 이 구조적으로 없다.
  const positives = [
    "김도영홈런몇개",
    "야구장잔디는천연잔디야인조야",
    "수비시프트제한이언제부터야",
  ];
  for (const q of positives) {
    for (let round = 1; round <= 3; round++) {
      const out = await normalizeQuestionLlm(q);
      const v = verdictOf(q, out.text);
      if (v.accepted && v.status === "accepted_surface") {
        pass++;
        report.push(`PASS 양성 r${round} [${v.status}]: ${q} → ${v.candidate}`);
      } else {
        fail++;
        report.push(`FAIL 양성 r${round} [${v.status}]: ${q} → ${JSON.stringify(out.text)}`);
      }
    }
  }

  // ── 반대편: 정상 표기는 SSOT 기준 미수용으로 수렴 ────────────────────────
  const negatives = [
    "김도영 홈런 몇 개야?",
    "보크가 뭐야?",
    "오늘 LG 경기 몇 시에 시작해?",
  ];
  for (const q of negatives) {
    const out = await normalizeQuestionLlm(q);
    const v = verdictOf(q, out.text);
    if (!v.accepted) {
      pass++;
      report.push(`PASS 반대편(미수용 ${v.status}): ${q}`);
    } else {
      fail++;
      report.push(`FAIL 반대편(수용됨 ${v.status}): ${q} → ${v.candidate}`);
    }
  }

  // ── 숫자 보존: 숫자 포함 붙여쓰기 질문 ───────────────────────────────────
  {
    const q = "30-30클럽이몬가요";
    const out = await normalizeQuestionLlm(q);
    const candidate = (out.text ?? "").trim();
    const digitsOk = candidate.length === 0 || digitSequencesMatch(q, candidate);
    if (digitsOk) {
      pass++;
      report.push(`PASS 숫자 보존: ${q} → ${JSON.stringify(out.text)}`);
    } else {
      fail++;
      report.push(`FAIL 숫자 변경: ${q} → ${JSON.stringify(out.text)}`);
    }
  }

  for (const line of report) console.log(line);
  console.log(`genius-question-normalize-live: PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
