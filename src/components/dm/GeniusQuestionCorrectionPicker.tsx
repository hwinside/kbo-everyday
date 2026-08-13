"use client";

/**
 * 야잘알봇 Tier B 오탈자 교정 제안 카드.
 *
 * 후보를 **자동 적용하지 않고** 유저 확인을 받는다(#1151 계약 유지). 그래서 카드에는
 * 반드시 거절 경로가 함께 있어야 한다 — 제안만 있고 닫는 길이 없으면 유저는 원문 답변을
 * 영영 못 받고, 서버는 같은 제안을 계속 다시 낸다.
 *
 * `onRespond(후보)` = 선택, `onRespond(null)` = 거절(원문 그대로 진행).
 */
export default function GeniusQuestionCorrectionPicker({
  options,
  onRespond,
  disabled = false,
}: {
  options: string[];
  onRespond: (question: string | null) => void;
  disabled?: boolean;
}) {
  // 후보는 정확히 1개다(payload 검증과 같은 계약). 그 외는 그릴 것이 없다.
  if (options.length !== 1) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid="genius-question-correction-picker">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onRespond(options[0])}
        data-testid="genius-question-correction-option"
        className="rounded-xl border border-white/10 bg-bg-tertiary px-3 py-2.5 text-left text-sm font-medium text-text-primary transition-colors hover:border-accent/60 active:bg-white/5 disabled:opacity-50"
      >
        {options[0]}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onRespond(null)}
        data-testid="genius-question-correction-decline"
        className="rounded-xl px-3 py-2 text-left text-xs text-text-tertiary transition-colors hover:text-text-secondary disabled:opacity-50"
      >
        아니요, 원래 질문 그대로요
      </button>
    </div>
  );
}
