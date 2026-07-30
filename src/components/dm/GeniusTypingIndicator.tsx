"use client";

import { BASEBALL_GENIUS_NAME } from "@/lib/constants/baseball-genius";

export type GeniusTypingState = "idle" | "waiting" | "retrying" | "failed";

/**
 * 야잘알봇 답변 대기/실패 인디케이터 — 봇 말풍선(좌측) 자리에 렌더한다.
 * geniusReplyState(useDMChat)를 그대로 소비하며 별도 폴링/구독을 만들지 않는다.
 * - waiting/retrying: bounce 점 3개(답변 작성 중). prefers-reduced-motion 시 정적.
 * - failed: 오류 문구 + 다시 시도 버튼.
 */
export default function GeniusTypingIndicator({
  state,
  onRetry,
}: {
  state: GeniusTypingState;
  onRetry: () => void;
}) {
  if (state === "idle") return null;

  return (
    <div className="flex justify-start" data-testid="genius-typing-indicator" data-state={state}>
      <div className="max-w-[75%]">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-xs" aria-hidden>⚾</span>
          <span className="text-xs font-semibold text-text-secondary">{BASEBALL_GENIUS_NAME}</span>
        </div>
        {state === "failed" ? (
          <div className="px-3.5 py-2.5 rounded-2xl rounded-bl-md bg-bg-tertiary text-sm leading-relaxed text-text-primary">
            <span>답변을 받지 못했어요.</span>{" "}
            <button
              type="button"
              onClick={onRetry}
              className="font-semibold text-accent underline"
            >
              다시 시도
            </button>
          </div>
        ) : (
          <div
            className="px-3.5 py-3 rounded-2xl rounded-bl-md bg-bg-tertiary"
            role="status"
            aria-label="답변 작성 중"
          >
            <span className="sr-only">답변 작성 중…</span>
            <span className="flex items-center gap-1" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="inline-block h-1.5 w-1.5 rounded-full bg-text-tertiary animate-bounce motion-reduce:animate-none"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
