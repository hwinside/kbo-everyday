#!/usr/bin/env node
/**
 * RAG-first 라우팅 게이트의 **검증력 증명**.
 *
 * 계약: 원본을 in-memory 백업 → 결함 주입 → smoke 재실행 → 의도한 FAIL 마커가 나와야 RED.
 * 앵커 부재 = 러너 고장으로 MISS (조용한 skip 금지). 종료 시 무조건 원복.
 *
 * ⚠️ 왜 이게 필요한가 — 1차 게이트는 소스 grep 뿐이라 `isSupportedRuleTermQuestion` 이
 *   진입 조건에서 빠졌다는 것만 보고 GREEN 을 냈고, 실제로는 `llm_scope_gate` 가 같은 문을
 *   닫고 있었다. **selftest 통과는 아무것도 증명하지 않는다** — 실제 결함을 주입해
 *   RED 가 나야 그 축이 살아 있는 것이다(M90).
 *
 * 🔴 2026-08-27 ⓒ 범위로 재작성. 소유권 판정(잔여질문 probe·전용 임계)을 이 PR 에서
 *   걷어냈으므로 그 축(구 r3~r7·r13)은 **없는 결함을 주입하는 셈**이라 폐기하고,
 *   대신 ⓒ 의 실제 계약("엔티티 결속 질문은 main 그대로")을 뚫는 변이로 교체했다.
 *   mutant 가 결함이 아니면 그건 게이트 결함이 아니라 내 변이 결함이다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const RETRIEVE = "src/lib/baseball-qa/rag/retrieve.ts";
const SERVER = "src/lib/baseball-qa/server.ts";
const SMOKE = "scripts/qa/genius-rag-first-routing-smoke.ts";

const MUTATIONS = [
  {
    name: "r18 정의 fallback을 RECORD 분류기로 복귀 — 빈 검색 4턴이 정의답을 잃는다",
    file: PIPELINE,
    from: "rosterBlock, statNumericGuard && !statDefinition)",
    to: "rosterBlock, statNumericGuard)",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r19 정의 fallback 숫자 검증 제거 — 오타니 환각값이 유출된다",
    file: PIPELINE,
    from: "!numericTokensSubsetOf(definitionFallback.answer, question)",
    to: "false",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r20 정의 검증 표식 제거 — log crash 재생이 정상답을 되묻기로 바꾼다",
    file: PIPELINE,
    from: "statRuleTermVerified: Boolean(statDefinition && statNumericGuard),",
    to: "statRuleTermVerified: false,",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r16 정의 후속 문맥 전달 제거 — 직전 홀드 질문이 모델에 도달하지 않는다",
    file: PIPELINE,
    from: "{ context: definition?.context }",
    to: "{ context: undefined }",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r17 이유 질문 배제 제거 — 도루 불문율을 지표 정의로 오분류한다",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: " && !REASON_ASK.test(text)",
    to: "",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  // ── P0-1: 라우팅이 실제로 열렸는가 ──────────────────────────────────────
  {
    name: "r1 진입 조건에 scopeGate 복원 — 사전 밖 질문이 다시 문 앞에서 막힌다(1차 false-green 재현)",
    file: PIPELINE,
    from: "    (statDefinition || (ownedByEntityRag\n      ? isSupportedRuleTermQuestion(question, glossary, players)\n      : true)) &&",
    to: "    !scopeGate &&\n    (statDefinition || (ownedByEntityRag\n      ? isSupportedRuleTermQuestion(question, glossary, players)\n      : true)) &&",
  },
  {
    name: "r2 닫힌 단어 사전을 전면 복원 — 사전 밖 표현은 정본이 있어도 도달 못 한다",
    file: PIPELINE,
    from: "    (statDefinition || (ownedByEntityRag\n      ? isSupportedRuleTermQuestion(question, glossary, players)\n      : true)) &&",
    to: "    (statDefinition || isSupportedRuleTermQuestion(question, glossary, players)) &&",
  },

  // ── ⓒ 계약: 엔티티 결속 질문은 main 그대로 ──────────────────────────────
  {
    name: "r3 엔티티 결속에도 개방 적용 — 사건 질문(`문보경 삼진 당한 경기`)을 규칙집이 선점한다",
    file: PIPELINE,
    from: "    (statDefinition || (ownedByEntityRag\n      ? isSupportedRuleTermQuestion(question, glossary, players)\n      : true)) &&",
    to: "    true &&",
  },
  {
    name: "r4 구단을 엔티티 판정에서 제외 — `LG 트윈스 역사`를 규칙집이 가져간다",
    file: PIPELINE,
    from: "    mentionsAnyRosterName(question, players)\n    || mentionedTeamCanonicals(question).length > 0;",
    to: "    mentionsAnyRosterName(question, players);",
  },
  {
    name: "r5 선수를 엔티티 판정에서 제외 — `문보경 별명`을 규칙집이 가져간다",
    file: PIPELINE,
    from: "    mentionsAnyRosterName(question, players)\n    || mentionedTeamCanonicals(question).length > 0;",
    to: "    mentionedTeamCanonicals(question).length > 0;",
  },
  {
    // 🔴 삼순 2026-08-27 ① 회귀 변이. 직전 exact 가 정확히 이 상태였고 게이트는 GREEN 이었다.
    //   후보 해석기의 null 은 "엔티티 없음"이 아니라 "단일 후보로 못 좁힘"이라, 이 변이는
    //   `문보경 어제 무슨 일 있었어?`(0.3210)·복수 선수(0.3086)·복수 구단(0.2830)을 전부
    //   공식 RAG 로 흘린다 — 셋 다 임계 0.42 안이라 실제로 durable LLM 을 선점한다.
    name: "r15 지명 존재 → 단일·서빙가능 후보로 되돌림 (직전 exact 회귀 — 후보 null 집합이 샌다)",
    file: PIPELINE,
    from: "    mentionsAnyRosterName(question, players)\n    || mentionedTeamCanonicals(question).length > 0;",
    to: "    Boolean(enabledPlayerCandidate) || resolveRagTeamCandidate(question) !== null;",
  },
  {
    name: "r6 엔티티 결속 질문을 공식 경로에서 통째로 차단 — main 이 official 로 보내던 룰 질문이 죽는다",
    file: PIPELINE,
    from: "    (statDefinition || (ownedByEntityRag\n      ? isSupportedRuleTermQuestion(question, glossary, players)\n      : true)) &&",
    to: "    (statDefinition || !ownedByEntityRag) &&",
  },

  // ── 근거 판정이 개수가 아니라 거리라는 계약 ──────────────────────────────
  {
    name: "r8 RPC 임계 제거 — 무슨 질문이든 상한만큼 받아 100% 통과(환각 통로)",
    file: SERVER,
    from: "    p_max_distance: RAG_DOCUMENT_MAX_DISTANCE,",
    to: "",
  },
  {
    name: "r9 distance 전달 제거 — 임계 재보정 근거가 사라진다",
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
    // ⚠️ `void 0;` 같은 무해한 문장을 넣는 변이는 쓰지 않는다 — mutant 가 결함이 아니면
    //   그건 게이트 결함이 아니라 내 변이 결함이다(M90). 근거 0건에서도 종결시켜
    //   **실제로 기존 경로를 빼앗는** 형태로 주입한다.
    name: "r12 근거 없어도 공식 경로에서 종결 — 기존 종결(사전·구단·선수)을 전부 뺏는다",
    file: PIPELINE,
    from: "    if (official) return official;",
    to: "    if (official) return official;\n    return { status: 200, answer: UNCLEAR_ANSWER, source: \"unsure\", remaining };",
  },

  // ── 주제 이탈 선언 (Vercel RED 를 냈던 실재 회귀) ────────────────────────
  {
    name: "r14 주제 이탈 라우터 종결 제거 — `야구 얘기 그만하고 시를 써줘` 가 공식 RAG 를 탄다",
    file: PIPELINE,
    from: "  if (isTopicDismissal(question)) return \"blocked\";",
    to: "",
    smoke: "scripts/qa/baseball-qa-official-rag-smoke.ts",
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
  const intended = exitFail && (
    /genius-rag-first-routing-smoke FAIL:/.test(out)
    || /baseball QA official RAG: PASS=\d+ FAIL=[1-9]/.test(out)
    || /^FAIL /m.test(out)
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
