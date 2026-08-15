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
import {
  AUTH_ERROR_EVENT,
  AUTH_ERROR_STORAGE_KEY,
  getUserFacingAuthErrorFromUrl,
} from "@/lib/auth-error";
import { isNative, isAndroid } from "./platform";

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
  if (isAndroid) {
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
  if (!isNative || listenerRegistered) return;
  listenerRegistered = true;

  void subscribeAppUrlOpen("oauth", ({ url }) => void handleOAuthUrlOpen(url));
}

async function handleOAuthUrlOpen(url: string): Promise<void> {
    // keubo.fan Universal Link 또는 fan.keubo.app custom scheme에서 OAuth 토큰/코드 추출
    const isKeuboUniversalLink = url.includes("keubo.fan");
    const isKeuboCustomScheme = url.startsWith("fan.keubo.app://");
    if (!isKeuboUniversalLink && !isKeuboCustomScheme) return;

    try {
      // Android는 Chrome Custom Tab(OAuthBrowser)으로 열었으므로 같은 플러그인으로 닫음.
      if (isAndroid) {
        await OAuthBrowser.close();
      } else {
        await Browser.close();
      }
    } catch {
      // Browser가 이미 닫혀있을 수 있음
    }

    // Case 1: App Links가 /auth/callback?code=... 를 가로챈 경우
    // 서버에 도달하기 전이므로 클라이언트에서 직접 code exchange
    const urlObj = new URL(url);
    const userFacingError = getUserFacingAuthErrorFromUrl(urlObj);
    if (userFacingError) {
      sessionStorage.setItem(AUTH_ERROR_STORAGE_KEY, userFacingError);
      window.dispatchEvent(
        new CustomEvent(AUTH_ERROR_EVENT, { detail: userFacingError }),
      );
      return;
    }

    const code = urlObj.searchParams.get("code");
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        console.error("[capacitor/auth] exchangeCodeForSession failed:", error.message);
      }
      return;
    }

    // Case 2: 서버 콜백이 처리 후 keubo.fan#access_token=...&refresh_token=... 로 리다이렉트한 경우
    const hashIndex = url.indexOf("#");
    if (hashIndex === -1) return;

    const hash = url.substring(hashIndex + 1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");

    if (accessToken && refreshToken) {
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (error) {
        console.error("[capacitor/auth] setSession failed:", error.message);
      }
    }
}
