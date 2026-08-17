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
 * 방금 보낸 질문을 생각중 대상으로 삼는다 — **세션 통틀어 최신 1개만**.
 *
 * 하린아빠 2026-08-04 20:33: "세션동안 유지. 세션 중 중복으로 발화할 경우엔 윗쪽
 * 생각중입니다를 삭제하고 최신것만 노출."
 *
 * ⚠️ 트리거가 **전송 시점**인 이유 (삼순 #1102 2차 Blocker 1·2).
 *
 * 종전엔 outbox(`geniusReplyStates`)에서 파생했는데 그게 두 방향으로 틀렸다:
 *  ① **답변이 outbox 보다 먼저 도착하면** `observedBaseballQaReplyIdsRef` 가 먼저 채워져
 *     enqueue 자체를 건너뛴다 → 생각중이 **한 번도 안 생긴다**(실측 `outbox:0`).
 *  ② outbox 는 **localStorage 에 영속**된다 → reload/재진입에서 되살아난다.
 *     계약은 "세션 동안만 유지, 새로고침하면 사라짐"이다.
 *
 * 전송은 그 세션에서 내가 실제로 한 행위이므로 두 조건을 동시에 만족한다.
 * 반환은 단조 증가라 Realtime 순서 역전으로 과거 id 가 늦게 와도 최신을 되돌리지 않는다.
 */
export function markGeniusThinkingMessageId(
  sentMessageId: number,
  prev: number | null,
): number | null {
  if (!Number.isSafeInteger(sentMessageId) || sentMessageId < 1) return prev;
  return prev !== null && prev >= sentMessageId ? prev : sentMessageId;
}

/**
 * route parameter가 바뀔 때 세션 marker를 유지할지 결정한다.
 * draft(`""`)에서 RPC가 만든 실제 대화 id로 승격되는 한 경로만 같은 대화로 본다.
 * reload는 새 hook 인스턴스라 current가 null이고, 실제 대화 사이 이동은 항상 초기화한다.
 */
export function transitionGeniusThinkingMessageId(
  previousConversationId: string,
  nextConversationId: string,
  current: number | null,
): number | null {
  return previousConversationId === "" && nextConversationId !== "" ? current : null;
}

/**
 * 이 메시지 아래에 생각중 말풍선을 그릴지, 그리고 아직 대기 중인지.
 *
 * 🔴 **원복됨 (하린아빠 2026-08-17 19:46 "생각중 대화내용 남기기로 한거 원복해줘").**
 *
 * #1102 에서는 생각중 말풍선을 **대화 기록으로 남겼다**(답변 도착 후에도 말풍선·문구·
 * thinking 마스코트 잔존, 점 애니메이션만 정지). 하린아빠 지시로 그 설계를 되돌린다 —
 * 생각중은 **기다리는 동안만** 보이고 답변이 도착하면 사라진다.
 *
 * 그래서 `show` 를 `pending` 에 결속한다. 두 값을 따로 두지 않는 이유는, 나뉘어 있으면
 * "답변 왔는데 말풍선만 남는" 조합이 **구조적으로 다시 가능해지기** 때문이다.
 *
 * ⚠️ `failed` 도 사라진다. 실패는 바로 아래 실패·재시도 버블이 말하므로, 생각중이 함께
 * 남으면 화면이 "생각 중"과 "답변 못 받았어요"를 동시에 말하는 모순이 된다
 * (삼순 #1102 1차 P0-2 와 같은 축 — 그때는 `pending=false` 로 풀었고 지금은 사라진다).
 *
 * ⚠️ 알려진 대가: 사전 히트처럼 빠른 답변에서는 대기 구간이 ~0.5초라 캐릭터가 사람 눈에
 * 안 잡힌다(#1102 가 애초에 해결하려던 문제 · Production 실측 typing 노출 500ms).
 * 하린아빠가 그 잔존 설계를 원복하라고 했으므로 대기 노출 시간 문제는 다시 열린 상태로 둔다.
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
  const targeted =
    input.isGeniusConversation &&
    input.isMine &&
    input.thinkingMessageId !== null &&
    input.thinkingMessageId === input.messageId;
  if (!targeted) return { show: false, pending: false };
  const state = input.replyStates[input.messageId];
  const pending = state === "waiting" || state === "retrying";
  // 🔴 대기 중일 때만 보인다 — `show` 를 `pending` 과 같은 값으로 묶어 잔존 조합을 없앤다.
  return { show: pending, pending };
}
