/**
 * 종료 경기 relay 1회 fetch 게이트 (useGameRelay final 분기 SSOT).
 *
 * 버그(삼순 blocker 2): hidden 상태에서 live→final 로 전환되면 fetchRelay 가 즉시
 * return 하는데도 finalFetched 를 true 로 고정해버려, 다시 visible 로 돌아와도
 * relay fallback 이 영영 fetch 되지 않았다. 아래 순수 판정으로 (1) 실제 성공 뒤에만
 * latch, (2) not-fetched 상태에서 visible 복귀 시 재시도를 보장한다.
 */

/** 지금 final fetch 를 시도할지. 이미 성공 latch 됐거나 hidden 이면 skip. */
export function planFinalFetch(state: { finalFetched: boolean; visible: boolean }): "fetch" | "skip" {
  if (state.finalFetched) return "skip";
  if (!state.visible) return "skip";
  return "fetch";
}

/** fetch 시도 결과 반영 — 성공했을 때만 latch(true). 실패/스킵은 false 유지해 재시도 여지 남김. */
export function afterFinalFetch(finalFetched: boolean, success: boolean): boolean {
  return finalFetched || success;
}
