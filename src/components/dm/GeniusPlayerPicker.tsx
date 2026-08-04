"use client";

import type { GeniusPickerOption } from "@/lib/constants/baseball-genius";

/**
 * 야잘알봇 동명이인 선수 선택 카드.
 *
 * 로스터 실측(2026-08-03): 880명 중 32그룹 72명이 동명이인이고 그중 7그룹은 **같은 팀에도**
 * 동명이인이 있다(김민준·김태훈·김현수·박준영·이서준·이승현·이주형). 그래서 팀만 보여주면
 * 여전히 구분이 안 되고, 팀+포지션+등번호를 함께 보여준다.
 *
 * 선택값은 화면에 보이는 표시값이 아니라 항상 `kbo_id`다 — 이름·팀이 같아도 id는 유일하다.
 */
export default function GeniusPlayerPicker({
  options,
  onPick,
  disabled = false,
}: {
  options: GeniusPickerOption[];
  onPick: (option: GeniusPickerOption) => void;
  disabled?: boolean;
}) {
  if (options.length === 0) return null;

  return (
    <div
      className="mt-2 flex flex-col gap-1.5"
      data-testid="genius-player-picker"
      data-option-count={options.length}
    >
      {options.map((option) => (
        <button
          key={option.kbo_id}
          type="button"
          disabled={disabled}
          onClick={() => onPick(option)}
          data-testid="genius-player-picker-option"
          data-kbo-id={option.kbo_id}
          className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-bg-tertiary px-3 py-2.5 text-left transition-colors hover:border-accent/60 active:bg-white/5 disabled:opacity-50"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-sm font-semibold text-text-primary">{option.name}</span>
            {option.team ? (
              <span className="shrink-0 rounded-md bg-white/10 px-1.5 py-0.5 text-[11px] text-text-secondary">
                {option.team}
              </span>
            ) : null}
            {option.position ? (
              <span className="truncate text-[11px] text-text-tertiary">{option.position}</span>
            ) : null}
          </span>
          {option.back_no ? (
            <span className="shrink-0 text-xs font-medium text-text-tertiary">
              {`#${option.back_no}`}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
