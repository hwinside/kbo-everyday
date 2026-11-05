import { publishAuthError } from "@/lib/auth-error";

// This is a return hint, not an authentication timeout. Never expire a provider
// page while the user is entering credentials. Store no URL, code or token.
const KEY = "kbo-oauth-return-wait-v1";
const MAX_AGE = 15 * 60_000;
let waitingAt: number | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
export function beginOAuthReturnWait(): void {
  stopOAuthReturnWait();
  waitingAt = Date.now();
  try { sessionStorage.setItem(KEY, String(waitingAt)); } catch { /* memory fallback */ }
}
export function suspendOAuthReturnCheck(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
}
export function stopOAuthReturnWait(): void {
  suspendOAuthReturnCheck();
  waitingAt = null;
  try { sessionStorage.removeItem(KEY); } catch { /* memory fallback */ }
}
export function checkOAuthReturn(): void {
  if (timer) clearTimeout(timer);
  // Survive a WebView reload when sessionStorage survived. This is not proof
  // that the verifier survived; Android process-death recovery is separate.
  if (waitingAt === null) {
    try {
      const stored = sessionStorage.getItem(KEY);
      if (stored && Number.isFinite(Number(stored))) waitingAt = Number(stored);
    } catch { /* memory fallback */ }
  }
  if (waitingAt === null) return;
  const age = Date.now() - waitingAt;
  if (age < 0 || age > MAX_AGE) { stopOAuthReturnWait(); return; }
  // appStateChange can arrive before appUrlOpen. Let the dispatcher take over;
  // receiving a callback cancels this timer before any session exchange starts.
  timer = setTimeout(() => {
    timer = undefined;
    if (waitingAt !== null) publishAuthError("oauth_return");
  }, 2_000);
}
