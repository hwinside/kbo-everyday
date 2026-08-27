#!/usr/bin/env node
/**
 * RAG-first 라우팅 게이트의 **검증력 증명** (삼순 2026-08-27 NO-GO 3축 요구).
 *
 * 계약: 원본을 in-memory 백업 → 결함 주입 → smoke 재실행 → 의도한 FAIL 마커가 나와야 RED.
 * 앵커 부재 = 러너 고장으로 MISS (조용한 skip 금지). 종료 시 무조건 원복.
 *
 * ⚠️ 왜 이게 필요한가 — 1차 게이트는 소스 grep 뿐이라 `isSupportedRuleTermQuestion` 이
 *   진입 조건에서 빠졌다는 것만 보고 GREEN 을 냈고, 실제로는 `llm_scope_gate` 가 같은 문을
 *   닫고 있었다. **selftest 통과는 아무것도 증명하지 않는다** — 실제 결함을 주입해
 *   RED 가 나야 그 축이 살아 있는 것이다(M90).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const RETRIEVE = "src/lib/baseball-qa/rag/retrieve.ts";
const SERVER = "src/lib/baseball-qa/server.ts";
const SMOKE = "scripts/qa/genius-rag-first-routing-smoke.ts";

const MUTATIONS = [
  // ── 삼순 P0-1: 라우팅이 실제로 열렸는가 ──────────────────────────────────
  {
    name: "r1 진입 조건에 scopeGate 복원 — 사전 밖 질문이 다시 문 앞에서 막힌다(1차 false-green 재현)",
    file: PIPELINE,
    from: "  if (\n    !ownedByEntityRag &&\n    deps.searchOfficialRag &&",
    to: "  if (\n    !scopeGate &&\n    !ownedByEntityRag &&\n    deps.searchOfficialRag &&",
  },
  {
    name: "r2 닫힌 단어 사전 복원 — 사전 밖 표현은 정본이 있어도 도달 못 한다",
    file: PIPELINE,
    from: "  if (\n    !ownedByEntityRag &&\n    deps.searchOfficialRag &&\n    deps.callOfficialRagLlm\n  ) {",
    to: "  if (\n    !ownedByEntityRag &&\n    deps.searchOfficialRag &&\n    deps.callOfficialRagLlm &&\n    isSupportedRuleTermQuestion(question, glossary, players)\n  ) {",
  },

  // ── 삼순 P0-2: 선수 결속 질문의 소유권 ───────────────────────────────────
  {
    name: "r3 소유권을 룰로 회귀 — Boolean(candidate) 로 되돌려 룰 질문을 선수가 가져간다",
    file: PIPELINE,
    from: "  const ownedByEntityRag = Boolean(officialOwnershipTarget) && officialOwnership === null;",
    to: "  const ownedByEntityRag = Boolean(officialOwnershipTarget);",
  },
  {
    name: "r4 소유권 전면 해제 — 선수 문서가 정본인 질문까지 규칙집이 가져간다",
    file: PIPELINE,
    from: "  const ownedByEntityRag = Boolean(officialOwnershipTarget) && officialOwnership === null;",
    to: "  const ownedByEntityRag = false;",
  },
  {
    name: "r5 이름 미제거 — 잔여 질문 대신 원문으로 판정해 벡터가 선수 문서로 끌린다",
    file: PIPELINE,
    from: "  const stripped = question.split(playerName).join(\" \").replace(/\\s+/g, \" \").trim();\n  return stripped.length >= 2 ? stripped : question;",
    to: "  return question;",
  },
  {
    name: "r6 소유권 임계를 서빙 임계까지 완화 — 선수 정본 질문을 규칙집이 뺏는다",
    file: RETRIEVE,
    from: "export const RAG_DOCUMENT_OWNERSHIP_MAX_DISTANCE = 0.36;",
    to: "export const RAG_DOCUMENT_OWNERSHIP_MAX_DISTANCE = 0.42;",
  },
  {
    name: "r7 거리 미제공을 0 으로 응급처리 — migration 이전 배포에서 소유권이 통째로 뒤집힌다",
    file: PIPELINE,
    from: "  if (typeof top.distance !== \"number\") return null;\n  if (top.distance > RAG_DOCUMENT_OWNERSHIP_MAX_DISTANCE) return null;",
    to: "  if ((top.distance ?? 0) > RAG_DOCUMENT_OWNERSHIP_MAX_DISTANCE) return null;",
  },

  // ── 근거 판정이 개수가 아니라 거리라는 계약 ──────────────────────────────
  {
    name: "r8 RPC 임계 제거 — 무슨 질문이든 상한만큼 받아 100% 통과(환각 통로)",
    file: SERVER,
    from: "    p_max_distance: RAG_DOCUMENT_MAX_DISTANCE,",
    to: "",
  },
  {
    name: "r9 distance 전달 제거 — 소유권 판정 근거도 72시간 재보정 근거도 사라진다",
    file: SERVER,
    from: "    distance: typeof row.distance === \"number\" ? row.distance : undefined,",
    to: "",
  },
  {
    name: "r10 서빙 임계를 무관 분포까지 열기 — 근거 없는 질문이 rag 로 서빙된다",
    file: RETRIEVE,
    from: "export const RAG_DOCUMENT_MAX_DISTANCE = 0.42;",
    to: "export const RAG_DOCUMENT_MAX_DISTANCE = 0.60;",
  },

  // ── 배포 순서 방어 ───────────────────────────────────────────────────────
  {
    name: "r11 PGRST202 fail-close 제거 — migration 이전 배포에서 유저에게 오류가 나간다",
    file: SERVER,
    from: "    if (error.code === \"PGRST202\") return [];\n    throw error;",
    to: "    throw error;",
  },

  // ── 넓히되 뺏지 않는다 ───────────────────────────────────────────────────
  {
    // 🔴 구단 축 — 1차 수정에서 선수만 다루다 `qa:genius-discard-reason` 이 잡은 실재 회귀다.
    //   구단을 소유권 판정에서 빼면 `LG 트윈스 역사 알려줘` 가 공식 RAG 로 새어 구단 문서
    //   대신 규칙집이 답한다(삼순 2026-08-07 P0-1 라우팅 역전).
    name: "r13 구단 소유권 제거 — 구단 서술 질문을 규칙집이 가져간다",
    file: PIPELINE,
    from: "    enabledPlayerCandidate?.name ?? resolveRagTeamCandidate(question)?.name ?? null;",
    to: "    enabledPlayerCandidate?.name ?? null;",
    smoke: "scripts/qa/genius-discard-reason-observability.ts",
  },
  {
    // ⚠️ `void 0;` 같은 무해한 문장을 넣는 변이는 쓰지 않는다 — mutant 가 결함이 아니면
    //   그건 게이트 결함이 아니라 내 변이 결함이다(M90). 근거 0건에서도 종결시켜
    //   **실제로 기존 경로를 빼앗는** 형태로 주입한다.
    name: "r12 근거 없어도 공식 경로에서 종결 — 기존 종결(사전·구단·선수)을 전부 뺏는다",
    file: PIPELINE,
    from: "    if (official) return official;",
    to: "    if (official) return official;\n    return { status: 200, answer: UNCLEAR_ANSWER, source: \"unsure\", remaining };",
  },
];

let red = 0;
const misses = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.log(`MISS ${m.name} — 앵커 부재 (러너 고장)`);
    misses.push(m.name);
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  let out = "";
  let exitFail = false;
  try {
    out = execSync(`npx tsx ${m.smoke ?? SMOKE}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000 });
  } catch (error) {
    exitFail = true;
    out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  writeFileSync(m.file, original);
  // RED = smoke 가 **의도한 FAIL 마커**를 찍고 죽었다. 컴파일 오류 같은 아무 nonzero exit 를
  // 검출로 세면 검증력이 0 이다(삼순 2026-08-10 B5).
  // RED 판정 키는 **실패 줄에만** 나타나야 한다(통과 출력과 겹치면 false-green).
  //   smoke 를 갈아끼울 수 있으므로 두 러너의 FAIL 마커를 모두 인정한다.
  const intended = exitFail && (
    /genius-rag-first-routing-smoke FAIL:/.test(out) || /^FAIL /m.test(out)
  );
  if (intended) {
    console.log(`RED  ${m.name}`);
    red++;
  } else if (exitFail) {
    console.log(`MISS ${m.name} — 프로세스는 죽었지만 의도한 FAIL 마커가 아니다 (러너/컴파일 고장)`);
    misses.push(m.name);
  } else {
    console.log(`MISS ${m.name} — 결함이 통과했다 (검출력 0)`);
    misses.push(m.name);
  }
}

console.log(misses.length === 0 ? `\n✅ mutations: ${red}/${MUTATIONS.length} RED` : `\n❌ ${misses.length} 축 미검출`);
if (misses.length > 0) process.exitCode = 1;
