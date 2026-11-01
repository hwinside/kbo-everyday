/** Let a resumed WebView settle before issuing a request. `onLine` is only a
 * scheduling hint, not proof of connectivity. The caller must handle failure.
 */
export function installForegroundTask(task: () => void, initial = true): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const ready = () => document.visibilityState === "visible" && navigator.onLine;
  const schedule = () => {
    clear();
    if (!ready()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (ready()) task();
    }, 1_500);
  };
  window.addEventListener("focus", schedule);
  window.addEventListener("online", schedule);
  window.addEventListener("offline", clear);
  document.addEventListener("visibilitychange", schedule);
  if (initial) schedule();
  return () => {
    clear();
    window.removeEventListener("focus", schedule);
    window.removeEventListener("online", schedule);
    window.removeEventListener("offline", clear);
    document.removeEventListener("visibilitychange", schedule);
  };
}
