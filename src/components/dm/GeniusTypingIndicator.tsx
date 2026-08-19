"use client";

import {
  BASEBALL_GENIUS_FALLBACK_ANSWER,
  BASEBALL_GENIUS_NAME,
  type GeniusReplyKind,
} from "@/lib/constants/baseball-genius";
import GeniusMascotImage from "@/components/dm/GeniusMascotImage";

export type GeniusTypingState = "idle" | "waiting" | "retrying" | "failed";

/** 생각중 말풍선 문구. 대화 기록으로 남는 문장이라 상수로 둔다. */
export const GENIUS_THINKING_TEXT = "생각중입니다…";

/**
 * 대기/실패 상태도 마스코트를 같이 띄운다 (2026-08-02 하린아빠 지시).
 * 답변이 온 뒤에만 마스코트가 보이면 기다리는 동안 자리가 비어 말풍선이 튀다.
 *
 * ⚠️ 2026-08-16 영상 모션 전환: 종전에는 표정(GeniusMascotState)을 직접 골랐지만,
 * 이젠 클립 선택은 `geniusMotionClipFor(replyKind, messageId)` 단일 지점이 한다.
 * 그래서 여기서는 대기·실패를 **같은 의미 분류(reply_kind)** 로 번역해 넘긴다:
 * - waiting/retrying → `picker`(= 되묻는 중 = thinking 클립)
 * - failed → `unavailable`(= 답하지 못함 = bored 클립)
 * 매핑표를 여기서 재구현하지 않으므로 단일 지점이 바뀌면 여기도 같이 바뀐다.
 */
const STATE_TO_REPLY_KIND: Record<Exclude<GeniusTypingState, "idle">, GeniusReplyKind> = {
  waiting: "picker",
  retrying: "picker",
  failed: "unavailable",
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
export function GeniusThinkingBubble({ pending, showMascot = true }: { pending: boolean;
  /**
   * 마스코트 노출 여부 — **채팅창 전체 마스코트 최대 1개** 불변식(하린아빠 2026-08-15
   * 13:34·13:53 "하나의 봇과 대화하는 느낌")을 page 가 소유권 판정으로 강제한다.
   * 더 최신 마스코트(답변·실패)가 생기면 이 말풍선은 문장 기록만 남기고 마스코트를 숨긴다.
   * (2026-08-04 "캐릭터도 그대로 남아있게" 계약은 13:53 지시로 대체됐다.)
   * 단독 렌더(게이트 등) 기본값은 true — 컴포넌트 단독 계약은 그대로다.
   */
  showMascot?: boolean;
}) {
  // 🔴 원복됨 (하린아빠 2026-08-17 19:46 "생각중 대화내용 남기기로 한거 원복해줘").
  //    #1102 는 이 말풍선을 대화 기록으로 남겼다(답변 도착 후에도 잔존). 지시대로 되돌린다 —
  //    생각중은 **기다리는 동안만** 존재한다.
  //
  //    여기서 끊는 이유: page 의 `show` 판정만 바꾸면 이 컴포넌트는 여전히 `pending=false` 에도
  //    말풍선을 그릴 수 있어, 다른 호출자가 하나 생기는 순간 잔존이 되살아난다.
  //    반환을 막아 **잔존이 구조적으로 불가능**하게 한다.
  if (!pending) return null;
  return (
    <div className="flex justify-start" data-testid="genius-thinking-bubble" data-pending={pending}>
      <div className="max-w-[75%]">
        <div className="flex items-center gap-1.5 mb-1">
          {showMascot && (
            <GeniusMascotImage
              replyKind="picker"
              messageId={0}
              testId="genius-thinking-mascot"
            />
          )}
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
  showMascot = true,
}: {
  state: GeniusTypingState;
  onRetry: () => void;
  questionMessageId?: number;
  /** 마스코트 노출 여부 — 전체 최대 1개 불변식을 page 소유권 판정이 강제한다(위 주석). */
  showMascot?: boolean;
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
          {showMascot && (
            <GeniusMascotImage
              replyKind={STATE_TO_REPLY_KIND[state]}
              messageId={questionMessageId ?? 0}
              testId="genius-typing-mascot"
            />
          )}
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
