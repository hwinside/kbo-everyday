import type { QaResult } from "@/lib/baseball-qa/pipeline";

/**
 * 파이프라인 결과를 job "ready" 전환 계획으로 바꾸는 SSOT.
 *
 * 🔴 직전 회차 결손(삼순 2026-08-13 quota/crash): 교정 제안은 quota 반납과 후보 durable
 *    저장이 **한 트랜잭션**이어야 하는데, 그 분기가 `server.ts` 안에 인라인으로만 있어
 *    게이트가 태울 수 없었다. 분기를 비원자 update 로 되돌려도 DB 게이트가 GREEN 이었다
 *    (= 배선이 죽어도 통과하는 false-green).
 *
 * 그래서 "어느 경로로 확정할지" 결정을 여기로 뺐다. 게이트가 이 함수를 그대로 실행해
 * 교정 제안이 실제로 settle RPC 로 가는지 판정한다.
 */
export type QuestionJobReadyPlan =
  | {
    /** quota 반납 + 후보 저장 + ready 전환을 한 트랜잭션으로 처리한다. */
    kind: "settle_correction";
    answer: string;
    correctionOption: string;
  }
  | {
    /** 그 외 답변 — 종전처럼 단순 update. 교정 칸은 반드시 비운다. */
    kind: "update";
    row: Record<string, unknown>;
  };

export function planQuestionJobReady(
  result: Pick<QaResult, "answer" | "source" | "remaining" | "pickerOptions" | "correctionOptions">,
  messageId: number,
): QuestionJobReadyPlan {
  // 교정 제안은 후보가 정확히 1개다(payload 계약과 동일). 그 외 형태는 신뢰하지 않는다.
  if (result.source === "question_correction" && result.correctionOptions?.length === 1) {
    return {
      kind: "settle_correction",
      answer: result.answer,
      correctionOption: result.correctionOptions[0],
    };
  }
  return {
    kind: "update",
    row: {
      status: "ready",
      answer: result.answer,
      source: result.source,
      remaining: result.remaining,
      picker_options: result.pickerOptions ?? null,
      picker_question_message_id: result.pickerOptions ? messageId : null,
      // 교정 경로가 아니면 교정 칸은 남아 있으면 안 된다 — 남으면 엉뚱한 답변에 카드가 붙는다.
      correction_options: null,
      correction_question_message_id: null,
    },
  };
}
