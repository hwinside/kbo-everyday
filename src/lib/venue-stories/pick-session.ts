/**
 * 파일 픽 in-flight 세션 상태 머신 (삼순 #805 blocker).
 *
 * iOS는 사진앱 영상 export 때문에 픽커 닫힘 → change 이벤트 사이에 수 초 지연이 있다.
 * 그 사이 사용자가 취소/닫기를 하면 뒤늦게 도착한 change(late change)는 무시해야 하고,
 * 준비 중 재진입(두 번째 픽커)도 막아야 한다.
 *
 * 규칙:
 * - open(): in-flight 픽이 없을 때만 시작(true). 이미 진행 중이면 재진입 차단(false).
 * - cancel(): 수동 취소·컴포저 닫기·reset — 세션 invalidate. 이후 도착하는 change는 무시된다.
 * - resolveChange(): change 도착 시 호출. 세션이 살아 있으면 true(파일 반영), 취소된 뒤면 false(late change 무시).
 */
export interface PickSession {
  open(): boolean;
  cancel(): void;
  resolveChange(): boolean;
  isPicking(): boolean;
}

export function createPickSession(onStateChange?: (picking: boolean) => void): PickSession {
  let active = false;
  const set = (next: boolean) => {
    if (active === next) return;
    active = next;
    onStateChange?.(next);
  };
  return {
    open() {
      if (active) return false;
      set(true);
      return true;
    },
    cancel() {
      set(false);
    },
    resolveChange() {
      if (!active) return false;
      set(false);
      return true;
    },
    isPicking: () => active,
  };
}
