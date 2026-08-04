import type { BaseballQaReplyStates } from "./client-outbox";

/**
 * 생각중 말풍선의 **선택·표시 규칙 SSOT**.
 *
 * ⚠️ 이 모듈이 따로 있는 이유 (삼순 #1102 1차 P0-1).
 *
 * 규칙이 `useDM` 의 effect 와 `page.tsx` 의 JSX 안에 인라인으로 흩어져 있으면 게이트가
 * 컴포넌트 단품만 렌더하게 되고, **페이지에서 말풍선을 통째로 지워도 GREEN** 이 된다
 * (삼순 mutation 실측: `showThinking = false` 로 바꿔도 18/18 통과).
 *
 * 그래서 규칙을 순수 함수로 끌어내 게이트가 **실제 배포되는 그 함수**를 Q1→Q2→reload
 * 시퀀스로 직접 실행하고, 페이지가 이 함수에 결속돼 있는지를 AST 로 확인한다.
 */

/**
 * 생각중 말풍선을 붙일 질문 id 를 고른다 — **세션 통틀어 최신 1개만**.
 *
 * 하린아빠 2026-08-04 20:33: "세션 중 중복으로 발화할 경우엔 윗쪽 생각중입니다를
 * 삭제하고 최신것만 노출."
 *
 * - `states` 가 비어도 `prev` 를 유지한다 → 답변이 도착해 outbox 가 비어도 말풍선이 남는다.
 *   (이게 이번 지시의 핵심이다. Production 실측상 대기 노출이 500ms 뿐이라 그냥 두면
 *    사람 눈에 안 잡힌다.)
 * - 새 질문이 오면 그 질문으로 갈아탄다 → 이전 생각중은 화면에서 사라진다.
 * - **단조 증가**다. Realtime 순서 역전으로 과거 상태가 늦게 도착해도 최신을 되돌리지 않는다.
 */
export function selectGeniusThinkingMessageId(
  states: BaseballQaReplyStates,
  prev: number | null,
): number | null {
  const ids = Object.keys(states)
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) return prev;
  const latest = Math.max(...ids);
  return prev !== null && prev >= latest ? prev : latest;
}

/**
 * 이 메시지 아래에 생각중 말풍선을 그릴지, 그리고 아직 대기 중인지.
 *
 * `pending` 은 **점 3개 애니메이션과 `role=status` 만** 가른다. 말풍선·문구·thinking
 * 마스코트는 답변 도착 후에도 남는다.
 *
 * ⚠️ `failed` 는 pending 이 아니다 (삼순 #1102 1차 P0-2). 종전엔 "outbox 에 있으면 true"
 * 였는데 그러면 실패 상태에서 점 3개가 계속 돌면서 바로 아래에 실패·재시도 버블이 같이
 * 떠, 화면이 "생각 중"과 "답변 못 받았어요"를 동시에 말하는 모순이 된다.
 */
export function resolveGeniusThinkingRender(input: {
  /** 야잘알봇 대화방인가. */
  isGeniusConversation: boolean;
  /** 이 메시지가 내가 보낸 질문인가. 생각중은 질문 바로 아래에 붙는다. */
  isMine: boolean;
  messageId: number;
  /** `selectGeniusThinkingMessageId` 결과. */
  thinkingMessageId: number | null;
  replyStates: BaseballQaReplyStates;
}): { show: boolean; pending: boolean } {
  const show =
    input.isGeniusConversation &&
    input.isMine &&
    input.thinkingMessageId !== null &&
    input.thinkingMessageId === input.messageId;
  if (!show) return { show: false, pending: false };
  const state = input.replyStates[input.messageId];
  return { show: true, pending: state === "waiting" || state === "retrying" };
}
