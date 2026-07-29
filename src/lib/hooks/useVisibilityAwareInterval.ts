import { useEffect, useRef } from "react";
import { startVisibilityPoller } from "@/lib/polling/visibility-poller";

/**
 * visibility-aware 폴링 훅.
 *
 * 탭이 백그라운드(document.hidden)면 폴링을 멈추고, 포그라운드 복귀 시 즉시 1회
 * 실행 후 재개한다. 보는 유저 실시간성은 100% 유지되고 안 보는 탭의 폴링 요청
 * (Edge Request)은 0이 된다.
 *
 * @param callback 폴링마다 실행할 콜백. ref로 최신값을 참조하므로 매 렌더 새 함수여도 재구독하지 않는다.
 * @param intervalMs 폴링 간격(ms).
 * @param options.enabled false면 폴링하지 않는다(기본 true).
 * @param options.resetKey 값이 바뀌면 폴링을 재시작한다. gameId 등 대상 전환용.
 * @param options.runImmediately false면 최초/대상전환 시 첫 실행을 intervalMs 뒤로 미룬다.
 */
export function useVisibilityAwareInterval(
  callback: () => void | Promise<void>,
  intervalMs: number,
  options?: { enabled?: boolean; resetKey?: string | number; runImmediately?: boolean },
): void {
  const enabled = options?.enabled ?? true;
  const resetKey = options?.resetKey;
  const cbRef = useRef(callback);
  // 렌더 중 ref 수정 금지 → effect에서 최신 callback 반영(폴링 tick은 비동기라 상 최신값 참조).
  useEffect(() => {
    cbRef.current = callback;
  });

  useEffect(() => {
    if (!enabled) return;
    // SSR/비브라우저: 폴링 없이 1회만.
    if (typeof document === "undefined") {
      void cbRef.current();
      return;
    }
    return startVisibilityPoller({
      isHidden: () => document.visibilityState === "hidden",
      onVisibilityChange: (handler) => {
        document.addEventListener("visibilitychange", handler);
        return () => document.removeEventListener("visibilitychange", handler);
      },
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (id) => window.clearTimeout(id),
      now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
      callback: () => cbRef.current(),
      intervalMs,
      runImmediately: options?.runImmediately,
    });
    // resetKey 변경 시 재구독(대상 전환 즉시 최신화). callback은 ref로 참조해 deps 제외.
  }, [enabled, intervalMs, resetKey, options?.runImmediately]);
}
