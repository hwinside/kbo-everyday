"use client";

export default function GeniusQuestionCorrectionPicker({
  options,
  onPick,
  disabled = false,
}: {
  options: string[];
  onPick: (question: string) => void;
  disabled?: boolean;
}) {
  if (options.length !== 1) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid="genius-question-correction-picker">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick(options[0])}
        data-testid="genius-question-correction-option"
        className="rounded-xl border border-white/10 bg-bg-tertiary px-3 py-2.5 text-left text-sm font-medium text-text-primary transition-colors hover:border-accent/60 active:bg-white/5 disabled:opacity-50"
      >
        {options[0]}
      </button>
    </div>
  );
}
