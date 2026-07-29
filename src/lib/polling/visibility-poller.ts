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

  const clear = () => {
    if (timer !== null) {
      deps.cancel(timer);
      timer = null;
    }
  };

  const tick = async () => {
    // 정리됐거나 숨겨졌으면 실행 안 함(visible 핸들러가 재개).
    if (cancelled || deps.isHidden()) return;
    await deps.callback();
    if (cancelled || deps.isHidden()) return;
    clear();
    timer = deps.schedule(() => { void tick(); }, deps.intervalMs);
  };

  const onVisibility = () => {
    if (cancelled) return;
    if (deps.isHidden()) {
      clear();
      return;
    }
    // 복귀: 진행 중 예약을 취소하고 즉시 1회 실행 + 재개.
    clear();
    void tick();
  };

  const unsubscribe = deps.onVisibilityChange(onVisibility);

  // 초기: 보일 때만 시작.
  if (!deps.isHidden()) void tick();

  return () => {
    cancelled = true;
    clear();
    unsubscribe();
  };
}
