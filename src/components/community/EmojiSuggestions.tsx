"use client";

import type { RefObject } from "react";

const SUGGESTIONS = [
  ["😂", "웃음"],
  ["😭", "눈물"],
  ["🙏", "기도"],
  ["👍", "최고"],
  ["👏", "박수"],
  ["🔥", "불꽃"],
  ["😍", "반했어요"],
  ["🎉", "축하"],
  ["👀", "눈길"],
  ["💪", "힘내요"],
  ["⚾", "야구"],
  ["💦", "땀방울"],
  ["🤬", "화나요"],
] as const;

interface EmojiSuggestionsProps {
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  disabled?: boolean;
  maxLength?: number;
}

/** Draft-only shortcuts: keep the selection/keyboard and use the existing send path. */
export default function EmojiSuggestions({ inputRef, onChange, disabled, maxLength }: EmojiSuggestionsProps) {
  function insertEmoji(emoji: string) {
    const input = inputRef.current;
    if (disabled || !input || input.disabled) return;

    // Read the live input so a just-committed IME character is not lost.
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = input.value.slice(0, start) + emoji + input.value.slice(end);
    const limit = maxLength ?? (input.maxLength >= 0 ? input.maxLength : undefined);
    // Reject the whole emoji rather than splitting a surrogate pair at the limit.
    if (limit !== undefined && next.length > limit) return;

    onChange(next);
    input.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      if (document.activeElement !== input || input.value !== next) return;
      input.setSelectionRange(start + emoji.length, start + emoji.length);
      if (input instanceof HTMLTextAreaElement) {
        input.style.height = "auto";
        input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
      }
    });
  }

  return (
    <div role="group" aria-label="추천 이모지" className="flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain hide-scrollbar">
      {SUGGESTIONS.map(([emoji, label]) => (
        <button
          key={emoji}
          type="button"
          aria-label={`${label} 이모지 추가`}
          title={label}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insertEmoji(emoji)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl hover:bg-bg-tertiary active:bg-bg-tertiary disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span aria-hidden="true">{emoji}</span>
        </button>
      ))}
    </div>
  );
}
