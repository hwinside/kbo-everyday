// LLM 위임 계약 mutation runner — PR #1139 (2026-08-10 방향 확정: 룰 최소화, LLM 위임)
//
// 판정축을 하나씩 죽여서 게이트(baseball-genius-context-smoke)가 RED 를 내는지 확인한다.
// 축: A(직전 턴 상시 로드·LLM 주입) · D(현재 소속 roster SSOT 데이터 주입) ·
//     프롬프트 계약(무관-무시·로스터 정본·정정 인정) · 요청 빌더(데이터 구획).
//
// ⚠️ 운영 규칙 (2026-08-09 #1137 교훈 + 2026-08-10 finally 원복 교훈):
//   • 원복은 in-memory 백업 → 파일 재작성. `git checkout --` 는 쓰지 않는다(P0).
//   • 앵커가 없으면 "검출 성공"이 아니라 **runner 고장**으로 실패시킨다.
//   • 아무 nonzero exit 을 RED 로 세지 않는다 — AssertionError 마커가 있어야 검출이다.
//   • 루프 안 process.exit 금지 — finally 원복을 건너뛰어 변이가 파일에 남는다(실측).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PIPELINE = path.join(root, "src/lib/baseball-qa/pipeline.ts");
const GEMINI = path.join(root, "src/lib/baseball-qa/gemini-request.ts");
const RETRIEVE = path.join(root, "src/lib/baseball-qa/rag/retrieve.ts");

const MUTATIONS = [
  // ── 축 A: 직전 턴 상시 로드 + LLM 주입 ──────────────────────────────────
  {
    id: "N1 직전 턴 상시 로드 제거",
    file: PIPELINE,
    anchor: "  if (deps.loadPreviousTurn) {\n    try {\n      const row = await deps.loadPreviousTurn();",
    replacement: "  if (false as boolean && deps.loadPreviousTurn) {\n    try {\n      const row = await deps.loadPreviousTurn!();",
    why: "후속 질문(`만루홈런이랑 비슷한 거야?`·`언제부터 그랬어?`)이 직전 턴 없이 끊긴다",
  },
  {
    id: "N2 generic LLM 에 context 미전달",
    file: PIPELINE,
    anchor: "llm = await deps.callLlm(question, context ?? undefined, rosterBlock);",
    replacement: "llm = await deps.callLlm(question, undefined, rosterBlock);",
    why: "직전 턴을 로드해 놓고 LLM 프롬프트에 싣지 않으면 후속 결속이 조용히 죽는다",
  },
  // ── 축 D: 현재 소속 roster SSOT ─────────────────────────────────────────
  {
    id: "N3 소속 블록 매칭 무력화",
    file: PIPELINE,
    anchor: "if (!inQuestion && !inContext) continue;",
    replacement: "continue;",
    why: "정정 질문(`최형우는 현재 삼성 소속인데??`)에 현재 소속 정본이 안 실린다",
  },
  {
    id: "N5 player rag extras 미전달",
    file: PIPELINE,
    anchor: "llm = await deps.callRagLlm!(question, evidence, extras);",
    replacement: "llm = await deps.callRagLlm!(question, evidence);",
    why: "선수 서술 답변이 직전 턴·현재 소속 없이 스냅샷만으로 생성된다",
  },
  {
    id: "N6 team rag extras 미전달",
    file: PIPELINE,
    anchor: "llm = await deps.callTeamRagLlm(question, evidence, extras);",
    replacement: "llm = await deps.callTeamRagLlm(question, evidence);",
    why: "구단 답변이 직전 턴·현재 명단 없이 스냅샷만으로 생성된다",
  },
  {
    id: "N7 이적 선수가 구단 명단에 남음 (팀 필터 제거)",
    file: PIPELINE,
    anchor: ".filter((player) => accepted.has((player.team ?? \"\").normalize(\"NFKC\").toLowerCase()))",
    replacement: "",
    why: "구단 명단 블록이 전 구단 선수를 담아 이적 선수(삼성 최형우)가 기아 명단에 남는다",
  },
  {
    id: "N24 1군 명단 freshness 제거 (stale 스냅샷이 당일 명단으로 나간다)",
    file: PIPELINE,
    anchor: "if (ageDays > TEAM_ENTRY_MAX_AGE_DAYS || ageDays < 0) return null;",
    replacement: "",
    why: "며칠씩 묵은 명단이 '당일 등록' 라벨로 서빙된다",
  },
  {
    id: "N25 인젝션 맥락 가드 제거 (인젝션 직전 턴이 프롬프트에 실린다)",
    file: PIPELINE,
    anchor: 'if (context && routeQuestion(context.question, glossary, players, false) === "blocked") {',
    replacement: "if (false as boolean) {",
    why: "unsure 로 떨어진 인젝션 문장이 다음 턴 LLM 프롬프트에 데이터로 주입된다",
  },
  {
    id: "N26 1군 명단 직접 렌더 분기 제거 (명단 질문이 RAG/news 로 샌다)",
    file: PIPELINE,
    anchor: "    deps.fetchTeamEntry && !enabledPlayerCandidate && isTeamEntryQuestion(question)",
    replacement: "    false as boolean",
    why: "`오늘 기아 1군 엔트리` 가 기사/나무위키 재서술로 새서 출처 오표기가 재발한다",
  },
  {
    id: "N29 직접 렌더를 news 뒤로 이동한 것과 동등 (news 게이트로 오염)",
    file: PIPELINE,
    anchor: "    deps.fetchTeamEntry && !enabledPlayerCandidate && isTeamEntryQuestion(question)",
    replacement: "    deps.fetchTeamEntry && !enabledPlayerCandidate && !deps.enableNewsRag && isTeamEntryQuestion(question)",
    why: "news 배선이 켜지면 명단 질문이 기사 경로에 선점된다 (삼순 반례)",
  },
  {
    id: "N30 kill-switch 재결합 (enableTeamRag 에 직접 렌더가 묶인다)",
    file: PIPELINE,
    anchor: "    deps.fetchTeamEntry && !enabledPlayerCandidate && isTeamEntryQuestion(question)",
    replacement: "    deps.enableTeamRag && deps.fetchTeamEntry && !enabledPlayerCandidate && isTeamEntryQuestion(question)",
    why: "TEAM_RAG_DISABLED=1 이면 구조화 정본 명단까지 같이 꺼진다 (삼순 반례)",
  },
  {
    id: "N31 full-string 문법 회귀 (단어 존재 판정으로 열린 서술이 명단 오답)",
    file: PIPELINE,
    anchor: "return /^(오늘|당일|현재|지금)?(의)?(1군|일군)(등록)?(엔트리|명단|선수들?(명단)?)?(은|는|이|가|좀|을|를)?(누구(야|예요|인가요)?|누가있(어|나요)?요?|알려줘|알려주세요|보여줘|보여주세요|뭐야|어떻게(돼|되나요))?$/.test(rest)\n    && /(1군|일군)/.test(rest);",
    replacement: "return /(1군|일군|엔트리)/.test(rest);",
    why: "`기아 1군은 왜 못해?`·`기아 2군 선수단` 이 1군 명단으로 답해진다 (삼순 2차 반례)",
  },
  {
    id: "N32 미래 경계 완충 회귀 (내일 날짜 통과)",
    file: PIPELINE,
    anchor: "if (ageDays > TEAM_ENTRY_MAX_AGE_DAYS || ageDays < 0) return null;",
    replacement: "if (ageDays > TEAM_ENTRY_MAX_AGE_DAYS || ageDays < -1) return null;",
    why: "내일 날짜 스냅샷이 '당일 등록' 으로 나간다 (삼순 반례)",
  },
  {
    id: "N27 1군 명단 완전성 가드 제거 (반쪽 명단이 나간다)",
    file: PIPELINE,
    anchor: "if (entry.players.length < 20 || entry.players.length > 40) return null;",
    replacement: "",
    why: "크롤 부분 실패의 12명짜리 명단이 '당일 등록' 으로 서빙된다 (삼순 blocker ①)",
  },
  {
    id: "N28 0근거 상시 양보 제거 (unsure 상용구 회귀)",
    file: PIPELINE,
    anchor: "  if (evidence.length === 0) return null;",
    replacement: "  if (evidence.length === 0) return failClose();",
    why: "chunk 0건 로스터 선수의 소속 정정·조회가 전부 '이해하지 못했어요' 로 돌아간다 (하린아빠 P0)",
  },
  // ── 프롬프트 계약 ───────────────────────────────────────────────────────
  {
    id: "N8 무관-무시 지시 제거 (generic)",
    file: GEMINI,
    anchor: '"단, 이번 질문이 직전 대화와 무관한 새 주제면 직전 대화는 완전히 무시하고 이번 질문만 답한다.",',
    replacement: "",
    why: "상시 주입된 직전 턴이 무관 질문까지 오염시킨다 — 이 지시가 룰 판정을 대체하는 안전판이다",
  },
  {
    id: "N9 후속-연결 지시 제거 (generic)",
    file: GEMINI,
    anchor: "\"이번 질문이 '언제?', '몇 순위?', '그거랑 비슷해?' 처럼 혼자서는 뜻이 안 되는 짧은 후속이면 직전 대화의 주제에 이어서 답한다.\",",
    replacement: "",
    why: "짧은 후속이 새 질문으로 오판된다 (00:57 캡처 `언제?` 실사고 축)",
  },
  {
    id: "N10 로스터 정본 지시 제거 (generic)",
    file: GEMINI,
    anchor: '"<현재 로스터> 블록이 함께 주어지면 그것이 선수의 현재 소속 구단에 대한 유일한 정본이다.",',
    replacement: "",
    why: "모델 기억·문서의 과거 소속이 현재 소속으로 답해진다",
  },
  {
    id: "N11 정정 인정 지시 제거 (generic)",
    file: GEMINI,
    anchor: '"지적이 로스터·자료로 확인되면 BASEBALL_RULE_TERM 으로 판정하고, 오류를 인정하며 정정한 사실을 답한다.",',
    replacement: "",
    why: "유저가 오류를 지적하면 모르겠다로 도망간다 (00:53 지적 축)",
  },
  {
    id: "N12 로스터 정본 지시 제거 (player rag)",
    file: RETRIEVE,
    anchor: '"<현재 로스터> 블록이 주어지면 그것이 선수의 현재 소속 구단의 유일한 정본이다.",',
    replacement: "",
    why: "스냅샷 소속이 현재 소속으로 답해진다",
  },
  {
    id: "N13 정정 인정 지시 제거 (player rag)",
    file: RETRIEVE,
    anchor: '"지적이 <현재 로스터>로 확인되면 GROUNDED로 판정하고, 오류를 인정하며 로스터 기준으로 정정해 답한다.",',
    replacement: "",
    why: "정정 발화가 INSUFFICIENT 로 도망간다",
  },
  {
    id: "N15 무관-무시 지시 제거 (team rag)",
    file: RETRIEVE,
    anchor: '"<직전 대화> 블록이 주어지고 이번 질문이 그 주제의 후속이면 이어서 답한다. 무관한 새 질문이면 직전 대화는 무시한다.",',
    replacement: "",
    why: "구단 경로에서 무관한 직전 턴이 답을 오염시킨다",
  },
  // ── 요청 빌더: 데이터 구획 ──────────────────────────────────────────────
  {
    id: "N16 RAG 요청에서 로스터 구획 제거",
    file: RETRIEVE,
    anchor: "if (extras.rosterBlock) {",
    replacement: "if (false as boolean) {",
    why: "지시는 있는데 데이터가 안 실린다 — 프롬프트 계약이 공약이 된다",
  },
  {
    id: "N17 RAG 요청에서 직전 대화 구획 제거",
    file: RETRIEVE,
    anchor: "if (extras.context) {",
    replacement: "if (false as boolean) {",
    why: "RAG 경로 후속·정정이 직전 턴 없이 생성된다",
  },
  {
    id: "N18 generic 요청에서 로스터 블록 제거",
    file: GEMINI,
    anchor: "const finalQuestion = rosterBlock",
    replacement: "const finalQuestion = false",
    why: "generic 경로에 현재 소속 데이터가 안 실린다",
  },
  // ── durable envelope 결속 (삼순 2026-08-10 P0 route-drift) — 게이트는 serving smoke ──
  {
    id: "N33 envelope 재생 무력화 (재처리가 raw 를 현재 경로 validator 로 재해석)",
    file: PIPELINE,
    anchor: '  if (!row || typeof row !== "object" || row[STORED_QA_FINAL_MARKER] !== true) return null;',
    replacement: "  return null;",
    gate: "scripts/qa/baseball-qa-rag-serving-smoke.ts",
    why: "generic↔RAG route-drift retry 에서 정상 저장 답이 다른 validator 로 접혀 바뀐다",
  },
  {
    id: "N34 generic 저장을 raw 로 회귀 (envelope 미결속)",
    file: PIPELINE,
    anchor: 'await deps.storeLlm(packStoredQaFinal(\n      { answer: validated.answer, source: "llm", cacheable: !context && !scopeGate && !rosterBlock },\n      llm,\n    ));',
    replacement: "await deps.storeLlm(llm);",
    gate: "scripts/qa/baseball-qa-rag-serving-smoke.ts",
    why: "0건→generic 저장 뒤 근거가 생기면 RAG validator 가 ANSWER 를 unsure 로 접는다",
  },
  {
    id: "N35 경계 envelope 재인식 제거 (TOCTOU — raw 재검증 회귀)",
    file: PIPELINE,
    anchor: "    const boundaryReplayed = await replayStoredFinalResult(llm, { userId, question, questionNorm, remaining, deps });\n    if (boundaryReplayed) return boundaryReplayed;",
    replacement: "",
    gate: "scripts/qa/baseball-qa-rag-serving-smoke.ts",
    why: "front null → 경계 envelope 전이에서 정상 final 이 unsure 로 재저장·덮어쓰기 된다 (삼순 3차)",
  },
  {
    id: "N36 front 조회 throw 를 null 진행으로 회귀",
    file: PIPELINE,
    anchor: '      // 조회 실패를 null 로 두면 검색·캐시가 저장 답을 다시 이길 수 있다 (삼순 3차).\n      // 답변 발송 없이 물러난다 — 저장 여부를 모르는 채 진행하지 않는다(fail-close).\n      return { status: 202, answer: "", source: "pending", remaining };',
    replacement: "      frontState = { started: false, result: null, ownerActive: false };",
    gate: "scripts/qa/baseball-qa-rag-serving-smoke.ts",
    why: "front 조회 실패 시 검색·캐시가 저장 답을 이겨 최종 답이 바뀔 수 있다 (삼순 3차)",
  },
  {
    id: "N37 player search-throw 선종결 CAS 결속 제거",
    file: PIPELINE,
    anchor: "    // 선종결 CAS 결속 (삼순 5차): error 발송도 durable 경계를 이긴 쪽만 한다.\n    return settleThroughDurableBoundary(\n      { answer: SYSTEM_ERROR_ANSWER, source: \"error\" }, null,\n      { userId, question, questionNorm, remaining, deps },\n    );",
    replacement: "    return failCloseError();",
    gate: "scripts/qa/baseball-qa-rag-serving-smoke.ts",
    why: "search throw 선종결이 durable 경계를 우회해 envelope/경합 worker 의 final 을 error 로 덮는다 (삼순 5차)",
  },
  {
    id: "N38 CAS 패배를 무시하고 발송 (competing 회귀)",
    file: PIPELINE,
    anchor: "  if (!won) return pending;",
    replacement: "",
    gate: "scripts/qa/baseball-qa-rag-serving-smoke.ts",
    why: "2차 null 직후 다른 worker 가 CAS 를 이겨도 이 worker 가 답을 발송해 두 답이 갈린다 (삼순 5차 c2)",
  },
];

function runSmoke(gate = "scripts/qa/baseball-genius-context-smoke.ts") {
  try {
    execFileSync("npx", ["tsx", gate], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 300_000,
    });
    return { failed: false, output: "" };
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    return { failed: true, output };
  }
}

// mutation 을 걸기 전 게이트가 GREEN 인지 먼저 확인한다 — baseline 이 RED 면 검출력 판정 불가.
{
  const baseline = runSmoke();
  if (baseline.failed) {
    console.error("❌ baseline 게이트가 이미 RED 다 — mutation 검출력 판정 불가");
    process.exit(1);
  }
}

let detected = 0;
const failures = [];
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, "utf-8");
  if (!original.includes(mutation.anchor)) {
    // 앵커 부재 = 대상 코드가 바뀌었는데 runner 가 못 따라온 것. 검출 성공으로 세지 않는다.
    console.error(`❌ RUNNER 고장 — 앵커 부재: ${mutation.id}`);
    console.error(`   anchor: ${mutation.anchor}`);
    failures.push(`anchor-missing: ${mutation.id}`);
    continue;
  }
  try {
    // 같은 계약 문구가 한 파일에 여러 번 있을 수 있다(선수·구단 프롬프트). 한 곳만 바꾸면
    // 다른 곳 앵커가 살아서 GREEN 이 된다(2026-08-10 N15 실측) — 전 occurrence 를 바꾼다.
    writeFileSync(mutation.file, original.split(mutation.anchor).join(mutation.replacement));
    const result = runSmoke(mutation.gate);
    const assertionRed = result.failed && /ERR_ASSERTION|AssertionError/.test(result.output);
    if (assertionRed) {
      console.log(`RED  ${mutation.id} — ${mutation.why}`);
      detected += 1;
    } else if (result.failed) {
      console.error(`❌ 검출 실패(비정상 종료만 있음, assertion 아님): ${mutation.id}`);
      failures.push(`abnormal: ${mutation.id}`);
    } else {
      console.error(`❌ 검출 실패(GREEN): ${mutation.id} — 게이트가 이 축을 지키지 못한다`);
      failures.push(`green: ${mutation.id}`);
    }
  } finally {
    // ⚠️ 여기서 process.exit 을 부르면 finally 가 건너뛰어져 **변이가 파일에 남는다**
    //   (2026-08-10 실측 — M13 GREEN 직후 exit 으로 context.ts 에 변이 잔류).
    //   실패는 모아서 루프 밖에서 종료한다.
    writeFileSync(mutation.file, original);
  }
}
if (failures.length > 0) {
  console.error(`❌ mutation 실패 ${failures.length}건: ${failures.join(", ")}`);
  process.exit(1);
}

// 원복 확인 — 원복이 안 됐으면 이후 게이트 전부가 오염된다.
{
  const restored = runSmoke();
  if (restored.failed) {
    console.error("❌ 원복 후 게이트 RED — 원복 실패");
    process.exit(1);
  }
}

console.log(`✅ llm-delegation mutation PASS (${detected}/${MUTATIONS.length} 전부 RED)`);
