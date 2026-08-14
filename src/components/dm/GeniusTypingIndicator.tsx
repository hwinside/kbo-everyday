"use client";

import {
  BASEBALL_GENIUS_FALLBACK_ANSWER,
  BASEBALL_GENIUS_NAME,
  geniusMascotSrc,
  type GeniusMascotState,
} from "@/lib/constants/baseball-genius";

export type GeniusTypingState = "idle" | "waiting" | "retrying" | "failed";

/** 생각중 말풍선 문구. 대화 기록으로 남는 문장이라 상수로 둔다. */
export const GENIUS_THINKING_TEXT = "생각중입니다…";

/**
 * 대기/실패 상태도 마스코트를 같이 띄운다 (2026-08-02 하린아빠 지시).
 * 답변이 온 뒤에만 마스코트가 보이면 기다리는 동안 자리가 비어 말풍선이 튀다.
 * - waiting/retrying → thinking(생각하는 표정)
 * - failed → unknown(몸하는 표정) — 답변 자체가 안 온 상황과 의미가 같다
 */
const STATE_TO_MASCOT: Record<Exclude<GeniusTypingState, "idle">, GeniusMascotState> = {
  waiting: "thinking",
  retrying: "thinking",
  failed: "unknown",
};

/**
 * 야잘알봇 답변 대기/실패 인디케이터 — 봇 말풍선(좌측) 자리에 렌더한다.
 * geniusReplyStates(useDMChat)의 질문별 상태를 소비하며 별도 폴링/구독을 만들지 않는다.
 * - waiting/retrying: bounce 점 3개(답변 작성 중). prefers-reduced-motion 시 정적.
 * - failed: 오류 문구 + 다시 시도 버튼.
 */
/**
 * 생각중 말풍선 — **답변이 온 뒤에도 대화에 그대로 남는다** (2026-08-04 하린아빠 20:27
 * "생각중입니다도 대화로 남겨. 캐릭터도 그대로 남아있게").
 *
 * ⚠️ 왜 필요한가 — Production 실측(2026-08-04, 100ms 간격):
 *   typing 노출 구간 +100ms ~ +500ms (**지속 500ms**), 답변 마스코트는 +700ms 등장.
 *   첫 측정값이 `0x32` — 그 0.5초 안에는 PNG 가 아직 로드도 안 된다.
 * 즉 사전 히트처럼 빠른 답변에서는 캐릭터가 **사람 눈에 안 잡힌다**(추가 진입은 캐시도 없음).
 *
 * 최소 노출시간 같은 타이머 꾼수 대신 **대화 기록으로 남기는** 방향을 택했다.
 * 지나가는 UI 가 아니라 질문 바로 아래 머무르는 말풍선이므로 노출시간 문제가 자연히 없어진다.
 *
 * 범위: **현재 보고 있는 대화 세션** 동안 유지된다(새로고침 시 사라짐).
 * 영구 저장하려면 봇이 실제 쪽지를 한 번 더 보내야 하고, 그러면 quota·푸시알림·dedup
 * 계약까지 바뀌는 큰 변경이 된다 — 이번 목적(안 보임)은 세션 유지로 충분히 해결된다.
 */
export function GeniusThinkingBubble({ pending }: { pending: boolean }) {
  return (
    <div className="flex justify-start" data-testid="genius-thinking-bubble" data-pending={pending}>
      <div className="max-w-[75%]">
        <div className="flex items-center gap-1.5 mb-1">
          {/* eslint-disable-next-line @next/next/no-img-element -- 정적 마스코트 PNG */}
          <img
            src={geniusMascotSrc("thinking")}
            alt=""
            aria-hidden
            data-testid="genius-thinking-mascot"
            data-mascot="thinking"
            className="h-8 w-auto max-w-none object-contain"
          />
          <span className="text-xs font-semibold text-text-secondary">{BASEBALL_GENIUS_NAME}</span>
        </div>
        <div
          className="px-3.5 py-2.5 rounded-2xl rounded-bl-md bg-bg-tertiary text-sm leading-relaxed text-text-primary inline-flex items-center gap-2"
          // 대기 중일 때만 상태를 알린다. 답변이 온 뒤에는 그냥 지나간 대화라 읽힌다.
          {...(pending ? { role: "status", "aria-label": "답변 작성 중" } : {})}
        >
          <span>{GENIUS_THINKING_TEXT}</span>
          {pending && (
            <span className="flex items-center gap-1" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="inline-block h-1.5 w-1.5 rounded-full bg-text-tertiary animate-bounce motion-reduce:animate-none"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function GeniusTypingIndicator({
  state,
  onRetry,
  questionMessageId,
}: {
  state: GeniusTypingState;
  onRetry: () => void;
  questionMessageId?: number;
}) {
  // ⚠️ 대기(waiting/retrying)는 이제 질문 바로 아래 `GeniusThinkingBubble` 이 맡는다.
  // 여기서도 그리면 대기 중 말풍선이 두 개 된다. 이 컴포넌트는 **실패 재시도**만 남긴다.
  if (state !== "failed") return null;

  return (
    <div
      className="flex justify-start"
      data-testid="genius-typing-indicator"
      data-state={state}
      data-genius-typing-question-id={questionMessageId}
    >
      <div className="max-w-[75%]">
        <div className="flex items-center gap-1.5 mb-1">
          {/* eslint-disable-next-line @next/next/no-img-element -- 정적 마스코트 PNG */}
          <img
            src={geniusMascotSrc(STATE_TO_MASCOT[state])}
            alt=""
            aria-hidden
            data-testid="genius-typing-mascot"
            data-mascot={STATE_TO_MASCOT[state]}
            className="h-8 w-auto max-w-none object-contain"
          />
          <span className="text-xs font-semibold text-text-secondary">{BASEBALL_GENIUS_NAME}</span>
        </div>
        {state === "failed" ? (
          <div className="px-3.5 py-2.5 rounded-2xl rounded-bl-md bg-bg-tertiary text-sm leading-relaxed text-text-primary">
            <span>{BASEBALL_GENIUS_FALLBACK_ANSWER}</span>{" "}
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
