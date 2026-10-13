/**
 * Capacitor OAuth 핸들러
 *
 * 네이티브 앱에서 OAuth 로그인 시:
 * 1. Browser.open()으로 Custom Tabs / SFSafariViewController에서 OAuth 진행
 * 2. 서버 콜백이 keubo.fan#access_token=...&refresh_token=... 로 리다이렉트
 * 3. App Links / Universal Links가 앱으로 URL을 전달
 * 4. appUrlOpen 이벤트에서 토큰 추출 → supabase.auth.setSession()
 */
import { Browser } from "@capacitor/browser";
import { registerPlugin } from "@capacitor/core";
import { subscribeAppUrlOpen } from "@/lib/capacitor/app-url-open";
import { supabase } from "@/lib/supabase/client";
import { clearAuthError, publishAuthError, getUserFacingAuthErrorFromUrl } from "@/lib/auth-error";
import { observeOAuth, setOAuthListenerReady } from "@/lib/auth/oauth-diagnostics";
import { oauthFailure } from "@/lib/auth/oauth-diagnostic-schema";
import { isNativeRuntime, isIosNativeRuntime } from "./platform";

let listenerRegistered = false;

/**
 * Android 전용 Chrome Custom Tab 런처 (네이티브 OAuthBrowserPlugin).
 * 삼성 인터넷이 기본 브라우저일 때 구글 계정 선택 화면 이메일이 자동 mailto 링크화돼
 * Gmail 작성으로 튀는 버그(#cs 2026-06-23) 회피 — OAuth만 Chrome Custom Tab으로 강제.
 */
interface OAuthBrowserPlugin {
  open(options: { url: string }): Promise<void>;
  close(): Promise<void>;
}
const OAuthBrowser = registerPlugin<OAuthBrowserPlugin>("OAuthBrowser");

/**
 * 네이티브 앱에서 OAuth URL을 Custom Tabs로 열기
 * Android = Chrome Custom Tab 강제(OAuthBrowser), iOS = SFSafariViewController(@capacitor/browser)
 */
export async function openOAuthInBrowser(url: string): Promise<void> {
  if (isNativeRuntime() && !isIosNativeRuntime()) {
    await OAuthBrowser.open({ url });
    return;
  }
  await Browser.open({ url, presentationStyle: "fullscreen" });
}

/**
 * appUrlOpen 리스너 등록 (앱 시작 시 1회 호출)
 * OAuth 콜백 URL을 가로채서 세션을 복원
 *
 * ⚠️ App.addListener 직접 등록 금지 — Capacitor iOS는 cold retained appUrlOpen을
 * 첫 리스너에만 전달 후 삭제한다. LA 딥링크 리스너와 독립 등록하면 등록 순서에
 * 따라 OAuth 콜백을 영영 못 받을 수 있다(삼순 #1204 R2). 단일 디스패쳐
 * (subscribeAppUrlOpen)로 구독 — 늘은 구독에도 replay로 전달된다.
 */
export function registerDeepLinkListener(): void {
  if (listenerRegistered) return;
  if (!isNativeRuntime()) { setOAuthListenerReady(false); return; }
  listenerRegistered = true;
  // Consumer readiness differs from native bridge attachment (dispatcher reports it).
  setOAuthListenerReady(true);
  void subscribeAppUrlOpen("oauth", ({ url }) => { void handleOAuthUrlOpen(url); });
}

let exchangePending = false;
export function isOAuthExchangePending(): boolean { return exchangePending; }

async function handleOAuthUrlOpen(url: string): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return; }
  if (!(parsed.protocol === "fan.keubo.app:" || (parsed.protocol === "https:" && ["keubo.fan", "www.keubo.fan"].includes(parsed.hostname)))) return;
  observeOAuth("callback");
  if (exchangePending) { observeOAuth("duplicate"); return; }
  exchangePending = true;
  // No Promise.race on the SDK: retain the lease until the original exchange
  // settles, even after timeout, so one-use codes cannot be replayed concurrently.
  const timer = setTimeout(() => {
    observeOAuth("pending");
    publishAuthError("oauth_pending");
  }, 15_000);
  try {
    // Browser.close must not hold up the actual authentication if its bridge hangs.
    try {
      const closing = isNativeRuntime() && !isIosNativeRuntime() ? OAuthBrowser.close() : Browser.close();
      void closing.catch(() => {});
    } catch { /* already closed or unavailable bridge; still exchange */ }
    const userFacingError = getUserFacingAuthErrorFromUrl(parsed);
    if (userFacingError) {
      observeOAuth("failed", "provider");
      publishAuthError(userFacingError);
      return;
    }
    const code = parsed.searchParams.get("code");
    const hash = new URLSearchParams(parsed.hash.slice(1));
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    if (!code && !(accessToken && refreshToken)) return;
    observeOAuth("exchange-start");
    const result = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : await supabase.auth.setSession({ access_token: accessToken!, refresh_token: refreshToken! });
    if (result.error || !result.data.session) {
      observeOAuth("failed", oauthFailure(result.error));
      publishAuthError("oauth_exchange");
      return;
    }
    observeOAuth("session-ready");
    clearAuthError();
  } catch (error) {
    observeOAuth("failed", oauthFailure(error));
    publishAuthError("oauth_exchange");
  } finally {
    clearTimeout(timer);
    exchangePending = false;
  }
}
