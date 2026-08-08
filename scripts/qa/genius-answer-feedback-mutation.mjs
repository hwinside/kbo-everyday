#!/usr/bin/env node
/**
 * 야잘알봇 답변 피드백 — **mutation 게이트** (삼순 NO-GO ⑥).
 *
 * 계약 게이트가 PASS 하는 것만으로는 "그 게이트가 결함을 잡을 수 있다"는 증명이 안 된다.
 * 실제 배포 소스를 하나씩 망가뜨려(mutation) **각각 RED 가 나는지** 확인한다.
 * 하나라도 GREEN 이면 그 축은 검출력이 0이므로 게이트로 신뢰할 수 없다 → 전체 실패.
 *
 * 검사 축 (삼순 지정 5종):
 *   M1 UI 결속 제거        — 답변에 피드백 컴포넌트를 안 그려도 통과하는가
 *   M2 ACL grant 제거      — service_role EXECUTE grant 를 빼도 통과하는가
 *   M3 route 검증 제거     — reply_kind / question_message_id 검증을 빼도 통과하는가
 *   M4 concurrency lock 제거 — advisory lock 을 빼도 통과하는가
 *   M5 44px 제거           — 터치 타깃을 28px 로 되돌려도 통과하는가
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

const R = (p) => new URL(`../../${p}`, import.meta.url).pathname;

const MUTATIONS = [
  {
    id: "M1",
    name: "UI 결속 제거 (답변에 피드백 컴포넌트 미렌더)",
    file: R("src/app/(main)/messages/[conversationId]/page.tsx"),
    apply: (s) => s.replace(/<GeniusAnswerFeedback\b/g, "<NeverRendered_GeniusAnswerFeedback"),
    detector: "structure",
  },
  {
    id: "M2",
    name: "ACL grant 제거 (service_role EXECUTE)",
    file: R("supabase/migrations/20260806150000_baseball_genius_answer_feedback.sql"),
    apply: (s) => s.replace(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role;/g, "-- removed"),
    detector: "structure",
  },
  {
    id: "M3",
    name: "route 대상 검증 제거 (reply_kind + match_path)",
    file: R("src/app/api/baseball-qa/feedback/route.ts"),
    apply: (s) =>
      s.replace(
        /if \(\s*!payload \|\|\s*!isFeedbackEligible\([\s\S]*?\)\s*\) \{[\s\S]*?\n  \}\n/,
        "",
      ),
    detector: "structure",
  },
  {
    id: "M4",
    name: "concurrency lock 제거 (advisory lock) — 실제 DB 병렬로 검증",
    file: R("supabase/migrations/20260806150000_baseball_genius_answer_feedback.sql"),
    apply: (s) => s.replace(/PERFORM pg_advisory_xact_lock\([\s\S]*?\);/, "-- removed"),
    detector: "db",
  },
  {
    id: "M6",
    name: "CAS 멱등 분기 제거 (재전송이 표를 뒤집음) — 실제 DB 로 검증",
    file: R("supabase/migrations/20260806150000_baseball_genius_answer_feedback.sql"),
    // 멱등 성공 분기를 죽인다 → 동일 set 재전송이 CAS 충돌(409)로 떨어져야 RED.
    apply: (s) => s.replace(
      /IF v_current IS NOT DISTINCT FROM p_desired THEN/,
      "IF FALSE THEN",
    ),
    detector: "db",
  },
  {
    id: "M13",
    name: "stale 충돌 검사 제거 (화면과 DB 가 갈라짐) — 실제 DB 로 검증",
    file: R("supabase/migrations/20260806150000_baseball_genius_answer_feedback.sql"),
    // 삼순 4차 P0 그 자체: 내가 보던 값이 아닌데도 그냥 적용해버리는 변종.
    apply: (s) => s.replace(
      /IF v_current IS DISTINCT FROM p_expected_prev THEN/,
      "IF FALSE THEN",
    ),
    detector: "db",
  },
  {
    id: "M7",
    name: "route 가 expectedPrev 를 안 넘김",
    file: R("src/app/api/baseball-qa/feedback/route.ts"),
    apply: (s) => s.replace(/p_expected_prev: expectedPrevValue,\n/, ""),
    detector: "structure",
  },
  {
    id: "M9",
    name: "UI 가 match_path 를 판정에 안 넘김 (스모톡에도 버튼이 붙음)",
    file: R("src/app/(main)/messages/[conversationId]/page.tsx"),
    apply: (s) => s.replace(/\n\s*geniusReply\?\.match_path,(?=\n\s*geniusReply\?\.question_message_id,)/, ""),
    detector: "structure",
  },
  {
    id: "M10",
    name: "allowlist 확대 (llm 유입 = 스몰톡에 버튼)",
    file: R("src/lib/baseball-qa/answer-feedback.ts"),
    apply: (s) =>
      s.replace(
        /export const FEEDBACK_ELIGIBLE_MATCH_PATHS = \[[^\]]*\] as const;/,
        'export const FEEDBACK_ELIGIBLE_MATCH_PATHS = ["rag", "dictionary", "llm"] as const;',
      ),
    detector: "contract",
  },
  {
    id: "M11",
    name: "allowlist 축소 (dictionary 누락 = 사전 답변 무음)",
    file: R("src/lib/baseball-qa/answer-feedback.ts"),
    apply: (s) =>
      s.replace(
        /export const FEEDBACK_ELIGIBLE_MATCH_PATHS = \[[^\]]*\] as const;/,
        'export const FEEDBACK_ELIGIBLE_MATCH_PATHS = ["rag"] as const;',
      ),
    detector: "contract",
  },
  {
    id: "M5",
    name: "44px 터치 타깃 제거",
    file: R("src/components/dm/GeniusAnswerFeedback.tsx"),
    apply: (s) => s.replace(/h-11 w-11 min-h-\[44px\] min-w-\[44px\]/g, "h-7 w-7"),
    detector: "structure",
  },
];

/**
 * 구조 검출기 — 배포 산출물에 필수 불변식이 살아 있는지 확인한다.
 * 각 불변식은 대응하는 mutation 이 죽였을 때 반드시 실패해야 한다.
 */
function runStructureChecks() {
  const fails = [];
  const page = readFileSync(R("src/app/(main)/messages/[conversationId]/page.tsx"), "utf8");
  const mig = readFileSync(
    R("supabase/migrations/20260806150000_baseball_genius_answer_feedback.sql"),
    "utf8",
  );
  const route = readFileSync(R("src/app/api/baseball-qa/feedback/route.ts"), "utf8");
  const ui = readFileSync(R("src/components/dm/GeniusAnswerFeedback.tsx"), "utf8");

  if (!/<GeniusAnswerFeedback\b/.test(page)) fails.push("M1: 답변 화면에 피드백 컴포넌트 결속 없음");
  if (!/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role;/.test(mig))
    fails.push("M2: service_role EXECUTE grant 없음");
  if (!/isFeedbackEligible\(\s*payload\.reply_kind,\s*payload\.match_path,/.test(route))
    fails.push("M3: route 에 대상 검증(reply_kind + match_path + qid) 없음");
  if (!/p_expected_prev: expectedPrevValue,/.test(route))
    fails.push("M7: route 가 expectedPrev 를 RPC 에 안 넘김");
  if (!/min-h-\[44px\]/.test(ui) || !/min-w-\[44px\]/.test(ui))
    fails.push("M5: 44px 터치 타깃 없음");
  // 하린아빠 2026-08-06: RAG 답변에만 붙인다. UI 가 match_path 를 안 넘기면
  // 판정이 undefined 로 떨어져 **전부 제외**되거나, 반대로 축이 통째로 죽는다.
  if (!/shouldShowFeedback\([\s\S]{0,240}?geniusReply\?\.match_path,/.test(page))
    fails.push("M9: UI 판정에 match_path 미전달 (RAG 한정 계약 무효)");
  if (!/shouldShowFeedback\([\s\S]{0,300}?geniusReply\?\.question_message_id,/.test(page))
    fails.push("M12: UI 판정에 qid 미전달 (결속 없는 답변에 죽은 버튼)");
  return fails;
}

/**
 * **실제 DB 동작 검증기** (삼순 4차 P0).
 *
 * M4(lock)·M6(CAS)를 정규식 존재검사로 두면 "그 문자열이 있다"만 증명될 뿐
 * **그게 동작한다**는 증명이 안 된다. 실제 임시 스키마에 migration 을 적용하고
 * route 를 태워 병렬·stale 경합을 돌리는 통합 게이트를 대신 실행한다.
 */
function runDbIntegration() {
  try {
    execSync("npx tsx scripts/qa/genius-answer-feedback-db-route-integration.ts", {
      cwd: R(""),
      stdio: "pipe",
    });
    return [];
  } catch (e) {
    return [`db: ${String(e.stdout ?? e.message).slice(-400)}`];
  }
}

function runContract() {
  try {
    execSync("npx tsx scripts/qa/genius-answer-feedback-contract.ts", {
      cwd: R(""),
      stdio: "pipe",
    });
    return [];
  } catch (e) {
    return [`contract: ${String(e.stdout ?? e.message).slice(-200)}`];
  }
}

// ── baseline: 변조 없이 전부 GREEN 이어야 한다 ────────────────────────────────
const baseStructure = runStructureChecks();
const baseContract = runContract();
const baseDb = runDbIntegration();
if (baseStructure.length || baseContract.length || baseDb.length) {
  console.error("❌ baseline 이 이미 실패한다 — mutation 검증 이전 문제:");
  for (const f of [...baseStructure, ...baseContract, ...baseDb]) console.error(`   ${f}`);
  process.exit(1);
}
console.log("✅ baseline GREEN");

// ── mutation: 각각 RED 가 나야 한다 ──────────────────────────────────────────
const green = [];
for (const m of MUTATIONS) {
  const backup = `${m.file}.mutbak`;
  copyFileSync(m.file, backup);
  try {
    const original = readFileSync(m.file, "utf8");
    const mutated = m.apply(original);
    if (mutated === original) {
      green.push(`${m.id} ${m.name} — 변조가 적용되지 않음(패턴 불일치)`);
      continue;
    }
    writeFileSync(m.file, mutated);
    const fails =
      m.detector === "structure" ? runStructureChecks() :
      m.detector === "db" ? runDbIntegration() :
      runContract();
    if (fails.length === 0) {
      green.push(`${m.id} ${m.name} — 죽였는데 GREEN (검출력 0)`);
    } else {
      console.log(`  RED ${m.id} ${m.name}`);
    }
  } finally {
    copyFileSync(backup, m.file);
    unlinkSync(backup);
  }
}

// 복원 확인 — 게이트가 소스를 망가뜨린 채 끝나면 안 된다.
const after = runStructureChecks();
if (after.length) {
  console.error("❌ 복원 실패 — 소스가 변조된 상태로 남았다:", after);
  process.exit(1);
}

if (green.length) {
  console.error(`❌ genius-answer-feedback-mutation FAILED (${green.length})`);
  for (const g of green) console.error(`  - ${g}`);
  process.exit(1);
}
console.log(`✅ genius-answer-feedback-mutation PASS (${MUTATIONS.length}종 전부 RED)`);
