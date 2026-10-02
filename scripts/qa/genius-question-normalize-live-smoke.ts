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
 *  · 고정 5회/문항, 양성 재현율은 비차단 관측값이다. 붙여쓰기는 accepted_surface, 용어 오타는 기대 후보.
 *    음성 오교정·양성의 잘못된 후보·숫자 변경은 0회여야 한다. 통과할 때까지 재시도하지 않는다.
 *  · TimeoutError는 SAMPLE_TIMEOUT/miss로 기록하고 고정 예산을 계속한다(추가 재시도 없음).
 *    모든 문항에서 실제 응답 ≥3/5가 필요하며 부족하면 HOLD(exit 2), unsafe는 FAIL(exit 1).
 *    timeout을 음성 PASS로 세지 않는다. 비타임아웃 오류는 명시적 실패로 유지한다.
 *  · 반대편: 이미 정상 표기인 질문은 SSOT 기준 미수용으로 수렴한다.
 *  · 숫자 포함 질문의 교정문은 숫자 시퀀스가 정확히 보존된다.
 *  · 키가 없으면 조용한 SKIP 이 아니라 명시적 실패(exit 1).
 *
 * 실행: npm run qa:genius-question-normalize-live (네트워크·GEMINI_API_KEY 필요, prebuild 밖)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LiveSampleBudget } from "./lib/live-sample-budget";

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
  const { digitSequencesMatch, evaluateNormalizedCandidate, resolveQuestionNormalization } = await import("../../src/lib/baseball-qa/pipeline");

  // 판정 입력을 파이프라인과 동일하게 — production 사전 + 배포 로스터 로더.
  const [glossary, players] = await Promise.all([loadGlossary(), loadRosterPlayers()]);
  assert.ok(glossary.length >= 100, `사전 로드 실패: ${glossary.length}`);
  assert.ok(players.length >= 500, `로스터 로드 실패: ${players.length}`);

  // Production provider boundary: a biased proposal must not contaminate the veto input.
  // Execute with mocked transport, then restore it before the real-provider matrix.
  const realFetch = globalThis.fetch;
  try {
    for (const status of ["valid", "unknown", "typo", "malformed", "unavailable"] as const) {
      const requests: Array<Record<string, unknown>> = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(JSON.parse(body.contents[0].parts[0].text));
        if (requests.length === 2 && status === "unavailable") throw new Error("fixture unavailable");
        const reply = requests.length === 1
          ? { originalSpelling: { status: "typo", quote: "쿼터" }, normalized: "커터가 뭐야?" }
          : { status };
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        }), { status: 200 });
      };
      const out = await normalizeQuestionLlm("쿼터가 뭐야?", glossary);
      assert.equal(requests.length, 2, "lexical assessment requires independent source check");
      assert.deepEqual(requests[1], { quote: "쿼터" }, "veto sees only original subject, never candidates/evidence");
      assert.equal(out.text, status === "typo" ? "커터가 뭐야?" : null);
      assert.equal(out.originalSpelling?.status, status === "typo" || status === "valid" ? status : "unknown");
      assert.equal(out.inputTokens, status === "unavailable" ? 10 : 20);
      assert.equal(out.outputTokens, status === "unavailable" ? 2 : 4);
    }
    // Quoted evidence must belong to the scope assessed in parallel.
    for (const quote of ["싸이클링", "싸이클링 히트", "뭐야", "", "없는말"]) {
      const requests: Array<Record<string, unknown>> = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const input = JSON.parse(body.contents[0].parts[0].text);
        requests.push(input);
        const reply = "spellingCandidates" in input
          ? { originalSpelling: { status: "typo", quote }, normalized: "사이클링 히트가 뭐야?" }
          : { status: "typo" };
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }));
      };
      const out = await normalizeQuestionLlm("싸이클링 히트가 뭐야?", glossary);
      assert.deepEqual(requests[1], { quote: "싸이클링 히트" });
      assert.equal(out.text, quote.startsWith("싸이클링") ? "사이클링 히트가 뭐야?" : null);
    }
    // A proposal response is deliberately held until the blind read starts.
    // Sequential execution must fail instead of silently reintroducing a round-trip.
    let releaseProposal: () => void = () => {};
    const blindStarted = new Promise<void>(resolve => { releaseProposal = resolve; });
    const timer = setTimeout(releaseProposal, 1000);
    let blindWasStarted = false;
    let proposalObservedBlind = false;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const input = JSON.parse(body.contents[0].parts[0].text);
      const proposal = "spellingCandidates" in input;
      if (proposal) {
        await blindStarted;
        proposalObservedBlind = blindWasStarted;
      } else {
        blindWasStarted = true;
        releaseProposal();
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(proposal
          ? { originalSpelling: { status: "valid", quote: "" }, normalized: null }
          : { status: "valid" }) }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      }), { status: 200 });
    };
    try {
      const out = await normalizeQuestionLlm("콜드", glossary);
      assert.ok(proposalObservedBlind, "blind read must start before proposal completes");
      assert.equal(out.inputTokens, 20, "count both calls even when no correction is proposed");
      assert.equal(out.outputTokens, 4);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    globalThis.fetch = realFetch;
  }

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

  // Fixed budget: no retry-until-green. Positive recall is observational;
  // every negative and every wrong lexical suggestion must have zero violations.
  const rounds = 5;
  const budget = new LiveSampleBudget(rounds, 3);
  async function sample(key: string, question: string, useGlossary = false) {
    const result = await budget.sample(key, () => normalizeQuestionLlm(question, useGlossary ? glossary : undefined));
    if (result.status === "timeout") {
      report.push(`SAMPLE_TIMEOUT (miss, not safe): ${key}`);
      return null;
    }
    return result.value;
  }

  // ── 양성: 붙여쓰기 → accepted_surface 비차단 재현율 ──────────────────────
  // surface 는 문자 구성 동일이라 "반대 의미·타 선수 추가" false-green 이 구조적으로 없다.
  const positives = [
    "김도영홈런몇개",
    "야구장잔디는천연잔디야인조야",
    "수비시프트제한이언제부터야",
  ];
  for (const q of positives) {
    let successes = 0;
    let unsafe = 0;
    for (let round = 1; round <= rounds; round++) {
      const out = await sample(`surface:${q}`, q);
      if (out === null) continue;
      const v = verdictOf(q, out.text);
      const ok = v.accepted && v.status === "accepted_surface";
      if (ok) successes++;
      const decision = resolveQuestionNormalization(q, out, glossary, players);
      if (decision.suggested) unsafe++;
      report.push(`${ok ? "SAMPLE_PASS" : "SAMPLE_MISS"} 양성 r${round} [${v.status}]: ${q} → ${JSON.stringify(out.text)}`);
    }
    const ok = unsafe === 0;
    const complete = (budget.counts.get(`surface:${q}`)?.observed ?? 0) >= budget.minimumObserved;
    if (!ok) fail++; else if (complete) pass++;
    report.push(`${!ok ? "FAIL" : complete ? "PASS" : "HOLD"} 양성: ${q} recall=${successes}/${rounds} (non-blocking), unsafe=${unsafe}`);
  }

  // ── 반대편: 정상 표기는 SSOT 기준 미수용으로 수렴 ────────────────────────
  const negatives = [
    "김도영 홈런 몇 개야?",
    "보크가 뭐야?",
    "오늘 LG 경기 몇 시에 시작해?",
  ];
  for (const q of negatives) {
    for (let round = 1; round <= rounds; round++) {
      const out = await sample(`negative:${q}`, q);
      if (out === null) continue;
      const v = verdictOf(q, out.text);
      if (!v.accepted) {
        pass++;
        report.push(`PASS 반대편 r${round}(미수용 ${v.status}): ${q}`);
      } else {
        fail++;
        report.push(`FAIL 반대편 r${round}(수용됨 ${v.status}): ${q} → ${v.candidate}`);
      }
    }
  }

  // ── 숫자 보존: 숫자 포함 붙여쓰기 질문 ───────────────────────────────────
  for (let round = 1; round <= rounds; round++) {
    const q = "30-30클럽이몬가요";
    const out = await sample(`digits:${q}`, q);
    if (out === null) continue;
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

  // Evidence-assisted spelling must preserve valid/common-word interpretations.
  for (const [question, expected] of [
    ["낙아웃이 뭐야", "낫아웃이 뭐야"],
    ["와일드업에 뭐야?", "와인드업이 뭐야?"],
    ["폭추", "폭투"],
    ["싸이클링 히트", "사이클링 히트"],
    ["싸이클링 히트가 뭐야?", "사이클링 히트가 뭐야?"],
    ["인플드플라이가 정확히 뭐야?", "인필드플라이가 정확히 뭐야?"],
    ["퓨쳐스리그", "퓨처스리그"],
    ["스트라이크 조은가?", null],
    ["쿼터가 뭐야?", null], ["워닝", null], ["세잎은?", null],
    ["삼성?", null], ["콜드", null], ["아하", null], ["내일은?", null],
  ] as const) {
    let successes = 0;
    let unsafe = 0;
    for (let round = 0; round < rounds; round++) {
      const out = await sample(`evidence:${question}`, question, true);
      if (out === null) continue;
      const decision = resolveQuestionNormalization(question, out, glossary, players);
      const candidate = decision.suggestionText ?? "";
      const suggests = decision.suggested;
      const ok = expected === null ? !suggests : suggests && candidate.replace(/\s+/g, "") === expected.replace(/\s+/g, "");
      if (ok) successes++;
      if (suggests && !ok) unsafe++;
      report.push(`${ok ? "SAMPLE_PASS" : "SAMPLE_MISS"} evidence r${round + 1}: ${question} → ${JSON.stringify({ provider: out, finalCandidate: candidate })}`);
    }
    const ok = unsafe === 0;
    const complete = (budget.counts.get(`evidence:${question}`)?.observed ?? 0) >= budget.minimumObserved;
    if (!ok) fail++; else if (complete) pass++;
    report.push(`${!ok ? "FAIL" : complete ? "PASS" : "HOLD"} evidence: ${question} recall=${successes}/${rounds} (non-blocking), unsafe=${unsafe}`);
  }

  const availability = budget.summary();
  for (const line of report) console.log(line);
  for (const row of availability.rows) {
    console.log(`AVAILABILITY ${row.key}: observed=${row.observed}/${rounds}, timeout=${row.timeouts}, minimum=3`);
  }
  const status = fail > 0 ? "FAIL" : availability.incomplete.length > 0 ? "HOLD" : "PASS";
  console.log(`Observed checks: PASS ${pass} / FAIL ${fail}`);
  console.log(`genius-question-normalize-live: ${status}; samples=${availability.attempted}, observed=${availability.observed}, timeout=${availability.timeouts}, insufficient=${availability.incomplete.length}`);
  if (fail > 0) process.exitCode = 1;
  else if (availability.incomplete.length > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
