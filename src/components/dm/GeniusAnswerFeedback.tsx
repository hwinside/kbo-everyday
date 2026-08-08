"use client";

import { ThumbsUp, ThumbsDown } from "lucide-react";
import type { GeniusFeedbackRating } from "@/lib/baseball-qa/answer-feedback";

/**
 * 야잘알봇 답변 품질 피드백 버튼 (👍/👎).
 *
 * 하린아빠 2026-08-05 18:09: "앞으로 모든 답변에 그냥 👍/👎 UI로 물어봐서 답변품질 데이터 적재".
 * 적재까지만이 이번 범위이고, 이 값이 답변 라우팅·캐시로 되먹여지는 경로는 없다.
 *
 * 사유 입력·별점·자유서술은 이번 범위 제외 — 한 번의 탭으로 끝나야 응답률이 나온다.
 */
export default function GeniusAnswerFeedback({
  rating,
  onRate,
  pending = false,
}: {
  /** 내 현재 표. null = 미투표(취소 포함) */
  rating: GeniusFeedbackRating | null;
  onRate: (rating: GeniusFeedbackRating) => void;
  pending?: boolean;
}) {
  return (
    <div
      className="mt-2 flex items-center gap-1"
      data-testid="genius-answer-feedback"
      data-rating={rating === null ? "none" : String(rating)}
      data-pending={pending ? "true" : "false"}
    >
      <button
        type="button"
        disabled={pending}
        onClick={() => onRate(1)}
        aria-label="이 답변이 도움이 됐어요"
        aria-pressed={rating === 1}
        data-testid="genius-feedback-up"
        data-selected={rating === 1 ? "true" : "false"}
        data-pending={pending ? "true" : "false"}
        className={`flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
          rating === 1
            ? "bg-accent/20 text-accent"
            : "text-text-tertiary hover:bg-white/5 hover:text-text-secondary"
        }`}
      >
        <ThumbsUp className="h-4 w-4" strokeWidth={rating === 1 ? 2.5 : 2} />
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => onRate(-1)}
        aria-label="이 답변이 아쉬워요"
        aria-pressed={rating === -1}
        data-testid="genius-feedback-down"
        data-selected={rating === -1 ? "true" : "false"}
        data-pending={pending ? "true" : "false"}
        className={`flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
          rating === -1
            ? "bg-white/15 text-text-primary"
            : "text-text-tertiary hover:bg-white/5 hover:text-text-secondary"
        }`}
      >
        <ThumbsDown className="h-4 w-4" strokeWidth={rating === -1 ? 2.5 : 2} />
      </button>
    </div>
  );
}
