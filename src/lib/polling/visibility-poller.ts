/**
 * visibility-aware 폴링 스케줄러 (순수 코어, DI로 테스트 가능).
 *
 * 목적: 탭이 백그라운드(document.hidden)면 폴링을 멈추고, 포그라운드 복귀 시
 * 즉시 1회 실행 후 재개한다. 보는 유저의 실시간성은 100% 유지되고,
 * 안 보는 탭의 폴링 요청(Edge Request)은 0이 된다.
 *
 * 동작:
 * - 초기: 보이면 즉시 1회 실행 + intervalMs 간격 재귀 폴링. 숨겨져 있으면 대기.
 * - 재귀 setTimeout(콜백 완료 후 다음 예약) → 느린 콜백에도 요청이 겹치지 않는다.
 * - hidden 전환: 예약 취소(폴링 정지).
 * - visible 복귀: 즉시 1회 실행 + 폴링 재개.
 *
 * single-flight fence: 콜백은 절대 겹치지 않는다(동시 실행 ≤ 1). 콜백이 in-flight인
 * 동안 visible 복귀가 들어오면 새 tick을 시작하지 않고 "복귀 후 1회 재실행"을
 * 큐잉했다가, 진행 중 콜백이 끝난 직후 정확히 1회만 즉시 재실행한다. 이로써
 * 느린 fetch 중 앱을 빠르게 나갔다 돌아와도 중복 Edge Request가 발생하지 않는다.
 *
 * DOM/timer/visibility를 전부 주입받아 결정론적으로 테스트한다.
 */
export interface VisibilityPollerDeps {
  /** 현재 탭이 백그라운드인지. */
  isHidden: () => boolean;
  /** visibility 변화 구독. 해제 함수를 반환한다. */
  onVisibilityChange: (handler: () => void) => () => void;
  /** setTimeout 상당. 타이머 id 반환. */
  schedule: (fn: () => void, ms: number) => number;
  /** clearTimeout 상당. */
  cancel: (id: number) => void;
  /** 폴링마다 호출할 콜백(비동기 허용). */
  callback: () => void | Promise<void>;
  /** 폴링 간격(ms). */
  intervalMs: number;
}

/**
 * 폴러를 시작하고 정리 함수를 반환한다.
 */
export function startVisibilityPoller(deps: VisibilityPollerDeps): () => void {
  let cancelled = false;
  let timer: number | null = null;
  let running = false;      // 콜백 in-flight 여부 (single-flight fence)
  let resumeQueued = false; // in-flight 중 들어온 visible 복귀 → settle 후 정확히 1회 재실행

  const clear = () => {
    if (timer !== null) {
      deps.cancel(timer);
      timer = null;
    }
  };

  const tick = async () => {
    // 정리됐거나 숨겨졌거나 이미 실행 중이면 새로 시작하지 않는다(겹침 방지).
    if (cancelled || deps.isHidden() || running) return;
    clear(); // 진행하므로 대기 중 예약 타이머 취소(타이머 ≤ 1 보장).
    running = true;
    try {
      await deps.callback();
    } finally {
      running = false;
    }
    if (cancelled) return;
    // in-flight 중 visible 복귀가 있었으면, 보이는 상태에서 정확히 1회 즉시 재실행.
    if (resumeQueued) {
      resumeQueued = false;
      if (!deps.isHidden()) {
        void tick();
        return;
      }
    }
    if (deps.isHidden()) return; // 숨김이면 정지(visible 핸들러가 재개).
    timer = deps.schedule(() => { void tick(); }, deps.intervalMs);
  };

  const onVisibility = () => {
    if (cancelled) return;
    if (deps.isHidden()) {
      clear();
      return;
    }
    // 복귀: 콜백이 in-flight면 새 tick을 시작하지 않고 settle 후 1회 재실행을 큐잉.
    if (running) {
      resumeQueued = true;
      return;
    }
    // idle 상태면 진행 중 예약을 취소하고 즉시 1회 실행 + 재개.
    clear();
    void tick();
  };

  const unsubscribe = deps.onVisibilityChange(onVisibility);

  // 초기: 보일 때만 시작.
  if (!deps.isHidden()) void tick();

  return () => {
    cancelled = true;
    resumeQueued = false;
    clear();
    unsubscribe();
  };
}
