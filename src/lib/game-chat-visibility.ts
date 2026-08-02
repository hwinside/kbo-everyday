export function shouldKeepCancelledGameChat(input: {
  hasGameProgress: boolean;
  hasExistingMessages: boolean;
}): boolean {
  return input.hasGameProgress || input.hasExistingMessages;
}

export type GameChatVisibilityState =
  | { status: "loading"; visible: false }
  | { status: "error"; visible: false }
  | { status: "ready"; visible: boolean };

/**
 * 채팅 설정이 확인되지 않았거나 OFF면 채팅 DOM 자체를 만들지 않는다.
 * 이 단일 게이트로 composer focus, hash/deep-link target, 자동 스크롤 대상을 함께 막는다.
 */
export function canRenderGameChat(state: GameChatVisibilityState): boolean {
  return state.status === "ready" && state.visible;
}
