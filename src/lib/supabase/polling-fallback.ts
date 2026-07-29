/**
 * Realtime 구독이 끊긴 동안(healthy=false)에만 load()를 주기 폴링하는 안전망 컨트롤러.
 *
 * 배경: 2026-07-28 피크에 Supabase Realtime 구독풀이 `Too many database timeouts`로
 * 산발적으로 죽었다. DM(useDM)·안읽음 카운트(useUnreadDMCount)는 폴링 폴백이 없어
 * 그 동안 새 쪽지/뱃지가 조용히 갱신 안 되는 무증상 유실 위험이 있었다.
 *
 * 설계 원칙:
 * - healthy=true(구독 정상)면 폴링하지 않는다 → 정상 상태 부하 0(중복 요청 폭주 방지).
 * - 탭이 보일 때만 폴링한다(백그라운드 탭 낭비 차단).
 * - 정상→비정상 전이(구독이 죽는 순간)와 탭 복귀 시 즉시 1회 catch-up 후 주기 재개.
 *
 * React 비의존 순수 컨트롤러 — setInterval/clearInterval/visibility 를 주입받아
 * 결정론 테스트가 가능하다. React 배선은 usePollingFallback 에서 한다.
 */
export interface PollingFallbackDeps<Handle> {
  /** 폴백으로 호출할 재조회. */
  load: () => void | Promise<void>;
  /** 폴링 주기(ms). */
  intervalMs: number;
  setInterval: (callback: () => void, ms: number) => Handle;
  clearInterval: (handle: Handle) => void;
  setTimeout: (callback: () => void, ms: number) => Handle;
  clearTimeout: (handle: Handle) => void;
  /** 현재 탭이 사용자에게 보이는가. */
  isVisible: () => boolean;
  /** terminal 동시 발생 시 catch-up herd 를 흩뜨리는 난수/상한. */
  random?: () => number;
  catchUpJitterMs?: number;
  pollJitterMs?: number;
}

export interface PollingFallbackController {
  /** 폴백 활성 조건(예: 로그인·대화 존재). */
  setEnabled: (enabled: boolean) => void;
  /** Realtime 구독이 정상(SUBSCRIBED)인가. false면 폴링 안전망 가동. */
  setHealthy: (healthy: boolean) => void;
  /** 탭 가시성 변경 시 호출. */
  onVisibilityChange: () => void;
  /** 컨트롤러 종료(타이머 정리). */
  stop: () => void;
  /** 현재 주기 폴링이 도는 중인지(테스트/관찰용). */
  isPolling: () => boolean;
  /** load single-flight 상태(테스트/관찰용). */
  loadState: () => { inFlight: boolean; queued: boolean };
}

export function createPollingFallback<Handle>(
  deps: PollingFallbackDeps<Handle>,
): PollingFallbackController {
  let enabled = false;
  let healthy = false;
  let timer: Handle | null = null;
  let catchUpTimer: Handle | null = null;
  let inFlight = false;
  let queued = false;
  let stopped = false;

  // 폴링이 돌아야 하는 조건: 활성 && 구독 비정상 && 탭 보임.
  const shouldRun = () => enabled && !healthy && deps.isVisible();

  const clearCatchUp = () => {
    if (catchUpTimer != null) {
      deps.clearTimeout(catchUpTimer);
      catchUpTimer = null;
    }
  };

  const runLoad = () => {
    if (!shouldRun() || stopped) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    Promise.resolve(deps.load())
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (!queued || !shouldRun() || stopped) {
          queued = false;
          return;
        }
        queued = false;
        runLoad();
      });
  };

  const scheduleCatchUp = () => {
    if (catchUpTimer != null || !shouldRun()) return;
    const jitterMs = Math.max(0, deps.catchUpJitterMs ?? 1_500);
    const random = Math.min(0.999999, Math.max(0, (deps.random ?? Math.random)()));
    const delay = Math.floor(random * jitterMs);
    catchUpTimer = deps.setTimeout(() => {
      catchUpTimer = null;
      runLoad();
    }, delay);
  };

  const tick = () => {
    // interval 콜백 시점에도 전체 실행 조건 재확인.
    runLoad();
  };

  const evaluate = () => {
    if (shouldRun()) {
      if (timer == null) {
        const jitterMs = Math.max(0, deps.pollJitterMs ?? 1_500);
        const random = Math.min(0.999999, Math.max(0, (deps.random ?? Math.random)()));
        timer = deps.setInterval(tick, deps.intervalMs + Math.floor(random * jitterMs));
      }
    } else if (timer != null) {
      deps.clearInterval(timer);
      timer = null;
    }
    if (!shouldRun()) {
      queued = false;
      clearCatchUp();
    }
  };

  return {
    setEnabled(next: boolean) {
      enabled = next;
      evaluate();
    },
    setHealthy(next: boolean) {
      const wasHealthy = healthy;
      healthy = next;
      // 정상→비정상 전이는 짧은 jitter 뒤 catch-up하고, interval phase도 클라이언트별로 흩뜨린다.
      if (wasHealthy && !next && enabled && deps.isVisible()) scheduleCatchUp();
      evaluate();
    },
    onVisibilityChange() {
      // 탭 복귀 & 비정상이면 즉시 catch-up 후 주기 재개. 숨김이면 주기 정지.
      if (shouldRun()) runLoad();
      evaluate();
    },
    stop() {
      stopped = true;
      queued = false;
      clearCatchUp();
      if (timer != null) {
        deps.clearInterval(timer);
        timer = null;
      }
    },
    isPolling() {
      return timer != null;
    },
    loadState() {
      return { inFlight, queued };
    },
  };
}
