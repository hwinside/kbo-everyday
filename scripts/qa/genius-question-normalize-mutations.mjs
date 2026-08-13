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
const PIPELINE = path.join(root, "src/lib/baseball-qa/pipeline.ts");
const LOG_ROW = path.join(root, "src/lib/baseball-qa/log-row.ts");
const PICKER = path.join(root, "src/components/dm/GeniusQuestionCorrectionPicker.tsx");
const USE_DM = path.join(root, "src/lib/supabase/useDM.ts");
const OUTBOX = path.join(root, "src/lib/baseball-qa/client-outbox.ts");
const SERVER = path.join(root, "src/lib/baseball-qa/server.ts");
const READY_PLAN = path.join(root, "src/lib/baseball-qa/job-ready-plan.ts");
const MIGRATION = path.join(
  root, "supabase/migrations/20260813203000_baseball_genius_question_correction_picker.sql",
);

/**
 * mutation 은 `file` 을 생략하면 pipeline.ts 를 대상으로 한다.
 * `gate` 를 주면 그 게이트로 RED 를 판정한다(기본 = normalize smoke).
 */
const GATES = {
  normalize: ["npx", ["tsx", "scripts/qa/genius-question-normalize-smoke.ts"]],
  correctionDb: ["npx", ["tsx", "scripts/qa/genius-question-correction-db.ts"]],
  pickerRender: ["npx", ["tsx", "scripts/qa/genius-picker-disabled-render.ts"]],
  dmRace: ["npx", ["tsx", "scripts/qa/genius-correction-dm-race.ts"]],
};

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
  {
    // 삼순 2026-08-13 ①: pipeline 이 후보를 만들어도 Production INSERT 에 칸이 없으면
    // 실 DB 는 계속 null 이다. 그 단절을 DB 게이트가 잡는지 증명한다.
    name: "M12 Production INSERT 에서 제안 칸 제거",
    file: LOG_ROW,
    gate: "correctionDb",
    find: 'question_correction_candidate: entry.correctionCandidate ?? null,',
    replace: '',
  },
  {
    name: "M13 Production INSERT 가 제안문을 수용문 칸에 섮음",
    file: LOG_ROW,
    gate: "correctionDb",
    find: 'question_normalized: entry.questionNormalized ?? null,',
    replace: 'question_normalized: entry.questionNormalized ?? entry.correctionCandidate ?? null,',
  },
  {
    // 삼순 2026-08-13 ②: 거절 버튼이 없으면 유저는 원문 답변을 받을 길이 없다.
    name: "M14 교정 카드에서 거절 버튼 제거",
    file: PICKER,
    gate: "pickerRender",
    find: 'data-testid="genius-question-correction-decline"',
    replace: 'data-testid="genius-question-correction-decline-REMOVED"',
  },
  {
    name: "M15 거절 버튼이 거절 대신 후보를 올림",
    file: PICKER,
    gate: "pickerRender",
    find: 'onClick={() => onRespond(null)}',
    replace: 'onClick={() => onRespond(options[0])}',
  },
  {
    name: "M16 교정 카드 disabled 무시(상호 잠금 붕괴)",
    file: PICKER,
    gate: "pickerRender",
    find: '        disabled={disabled}\n        onClick={() => onRespond(null)}',
    replace: '        onClick={() => onRespond(null)}',
  },
  {
    // 삼순 2026-08-13 교정 DM 선행 race: 선행관측 ref 가 picker 키만 보면
    // 교정 DM 이 먼저 왔을 때 late-enqueue 복원이 안 돌아 202 재시도가 반복된다.
    name: "M17 선행관측 ref 를 picker 키로 좌힘",
    file: USE_DM,
    gate: "dmRace",
    find: '        BASEBALL_QA_SELECTION_DEDUP_KEYS.some((prefix) =>\n          message.dedup_key === `${prefix}${messageId}`))) {',
    replace: '        message.dedup_key === `baseball-genius-picker:${messageId}`)) {',
  },
  {
    name: "M19 선택대기 키 집합에서 교정 제거",
    file: OUTBOX,
    gate: "dmRace",
    find: '  "baseball-genius-correction:",\n] as const;',
    replace: '] as const;',
  },
  {
    // 삼순 2026-08-13 quota/crash 의 핵심: 제안 확정이 반납을 함께 하지 않으면
    // 제안 턴에 차감이 남아 유저가 답도 못 받고 1회를 물린다(이중 과금).
    name: "M20 settle 에서 quota 반납 제거",
    file: MIGRATION,
    gate: "correctionDb",
    find: '    UPDATE public.genius_daily_usage\n    SET used = greatest(0, used - 1), updated_at = now()\n    WHERE user_id = p_user_id AND kst_day = v_day;',
    replace: '    NULL;',
  },
  {
    // 반대방향: 반납 표시를 안 남기면 선택 단계가 최종 답변용 예약을 새로 안 열어
    // 최종 답변이 무료로 나간다(used=0).
    name: "M20b settle 의 반납 표시 제거",
    file: MIGRATION,
    gate: "correctionDb",
    find: '      quota_released = CASE\n        WHEN v_job.quota_reserved AND coalesce(v_job.quota_allowed, false) = true THEN true\n        ELSE v_job.quota_released\n      END,',
    replace: '      quota_released = v_job.quota_released,',
  },
  {
    // 반납 전 fence 가 없으면 ready 일반답변은 quota 만 환불되고, 선택 후 재claim 된
    // processing 행은 구 worker 가 다시 교정 카드로 되돌릴 수 있다.
    name: "M20c settle 의 반납 전 결정 fence 제거",
    file: MIGRATION,
    gate: "correctionDb",
    find: "  IF v_job.status <> 'processing'\n     OR v_job.picked_normalized_question IS NOT NULL\n     OR v_job.correction_declined\n     OR v_job.correction_options IS NOT NULL THEN\n    RETURN false;\n  END IF;",
    replace: "  IF false THEN\n    RETURN false;\n  END IF;",
  },
  {
    // 배선 축: 서버가 settle 경로를 안 고르고 비원자 update 로 돌아가면
    // RPC 가 아무리 올바라도 Production 은 그걸 안 쓴다.
    name: "M21 교정 제안을 비원자 update 경로로 되돌림",
    file: READY_PLAN,
    gate: "correctionDb",
    find: '  if (result.source === "question_correction" && result.correctionOptions?.length === 1) {',
    replace: '  if (false) {',
  },
  {
    // 교정 경로가 아닌 답변이 교정 칸을 남기면 엉뚝한 답변에 카드가 붙는다.
    name: "M21b 일반 답변이 교정 칸을 그대로 남김",
    file: READY_PLAN,
    gate: "correctionDb",
    find: '      correction_options: null,\n      correction_question_message_id: null,',
    replace: '      correction_options: result.correctionOptions ?? null,\n      correction_question_message_id: messageId,',
  },
];

function runGate(name = "normalize") {
  const [cmd, args] = GATES[name];
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "pipe", timeout: 180_000 });
    return { code: 0, output: "" };
  } catch (err) {
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    return { code: err.status ?? 1, output };
  }
}

// 전제: 무변이 상태에서 쓰는 게이트는 전부 GREEN 이어야 한다 — 아니면 판정 자체가 무의미하다.
for (const g of new Set(mutations.map((m) => m.gate ?? "normalize"))) {
  const base = runGate(g);
  if (base.code !== 0) {
    console.error(`BASELINE RED (${g}) — 무변이 게이트가 이미 실패한다. mutation 판정 불가.`);
    console.error(base.output.slice(0, 2000));
    process.exit(1);
  }
}

const sources = new Map();
const backups = new Map();
for (const f of new Set(mutations.map((m) => m.file ?? PIPELINE))) {
  sources.set(f, readFileSync(f, "utf8"));
  const b = `${f}.qnorm-mutations.bak`;
  copyFileSync(f, b);
  backups.set(f, b);
}
let failures = 0;

try {
  for (const m of mutations) {
    const file = m.file ?? PIPELINE;
    const original = sources.get(file);
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
    writeFileSync(file, original.replace(m.find, m.replace));
    const res = runGate(m.gate);
    const assertionFailure = /AssertionError|ERR_ASSERTION|normalizer failure leaks|FAIL=/.test(res.output);
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
    copyFileSync(backups.get(file), file);
  }
} finally {
  for (const [f, b] of backups) {
    copyFileSync(b, f);
    rmSync(b, { force: true });
  }
}

if (failures > 0) {
  console.error(`mutation 게이트 실패: ${failures}건`);
  process.exit(1);
}
console.log(`genius-question-normalize-mutations: ${mutations.length}/${mutations.length} RED`);
