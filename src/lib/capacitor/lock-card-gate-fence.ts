// 잠금화면 카드 마스터 게이트 — load/bootstrap 결과가 사용자의 명시적 토글을 후승하지
// 못하게 막는 generation fence + 구빌드 마스터 컨트롤 판정 (순수 모듈, PR #686 삼순
// 재리뷰 blocker①② 대응). 브릿지/DOM 무의존 — scripts/qa/lock-card-gate-smoke.ts 대상.
//
// race 재현(삼순 지정): boot GET이 true를 읽음 → 사용자 OFF(clear+PUT false) → 늦게 끝난
// boot GET이 true를 다시 적용 → 다음 game_live에 카드 재게시. fence는 "캡처 시점 이후
// 명시 토글이 하나라도 있었으면 그 load 결과를 폐기"로 이를 봉인한다.

export interface LockCardGateFence {
  /** 명시적 사용자 토글마다 1씩 증가 — load 결과 유효성 판정 기준. */
  generation: number;
}

export function createLockCardGateFence(): LockCardGateFence {
  return { generation: 0 };
}

/** 명시적 사용자 토글(on/off/롤백) — fence 전진. 이보다 먼저 캡처된 load는 전부 무효. */
export function advanceLockCardGateFence(fence: LockCardGateFence): void {
  fence.generation += 1;
}

/** load/bootstrap GET *시작 전* 캡처 — 응답 적용 시 이 값으로 유효성 검사. */
export function captureLockCardGateFence(fence: LockCardGateFence): number {
  return fence.generation;
}

/** 캡처 이후 명시 토글이 없었을 때만 load 결과 적용 허용. */
export function shouldApplyLockCardLoad(fence: LockCardGateFence, captured: number): boolean {
  return fence.generation === captured;
}

/**
 * 마스터 토글(잠금화면 실시간 중계) 컨트롤 가능 여부 판정.
 * - iOS: W3c 서버 경로(push 제외+register skip)라 앱 빌드 무관 동작 → 항상 enabled.
 * - Android: 네이티브 setLockCardEnabled 게이트가 탑재된 빌드(vc14+)에서만 실제로 꺼짐.
 *   구빌드는 브릿지 silent no-op → OFF해도 카드가 계속 떠 CS 재현(삼순 blocker②) →
 *   마스터를 비활성+업데이트 안내. 판정은 빌드 번호 가정 대신 *capability 프로브*
 *   (getLockCardGateState 메서드 존재 여부)로 — null(미확인/프로브 전)은 fail-closed.
 * 카드 스타일·다시 표시 등 구빌드에서 실제 동작하는 제어는 이 판정에 묶지 않는다(분리 게이트).
 */
export type LockCardMasterControl = "enabled" | "needs-update";

export function decideLockCardMasterControl(input: {
  isAndroidNative: boolean;
  nativeGateSupported: boolean | null;
}): LockCardMasterControl {
  if (!input.isAndroidNative) return "enabled";
  return input.nativeGateSupported === true ? "enabled" : "needs-update";
}
