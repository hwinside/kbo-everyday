/**
 * Capacitor OAuth 핸들러
 *
 * 네이티브 앱에서 OAuth 로그인 시:
 * 1. Browser.open()으로 Custom Tabs / SFSafariViewController에서 OAuth 진행
 * 2. 서버 콜백이 keubo.fan#access_token=...&refresh_token=... 로 리다이렉트
 * 3. App Links / Universal Links가 앱으로 URL을 전달
 * 4. appUrlOpen 이벤트에서 토큰 추출 → supabase.auth.setSession()
 */
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { supabase } from "@/lib/supabase/client";
import { isNative } from "./platform";

let listenerRegistered = false;

/**
 * 네이티브 앱에서 OAuth URL을 Custom Tabs로 열기
 */
export async function openOAuthInBrowser(url: string): Promise<void> {
  await Browser.open({ url, presentationStyle: "fullscreen" });
}

/**
 * appUrlOpen 리스너 등록 (앱 시작 시 1회 호출)
 * OAuth 콜백 URL을 가로채서 세션을 복원
 */
export function registerDeepLinkListener(): void {
  if (!isNative || listenerRegistered) return;
  listenerRegistered = true;

  App.addListener("appUrlOpen", async ({ url }) => {
    // keubo.fan Universal Link 또는 fan.keubo.app custom scheme에서 OAuth 토큰/코드 추출
    const isKeuboUniversalLink = url.includes("keubo.fan");
    const isKeuboCustomScheme = url.startsWith("fan.keubo.app://");
    if (!isKeuboUniversalLink && !isKeuboCustomScheme) return;

    try {
      await Browser.close();
    } catch {
      // Browser가 이미 닫혀있을 수 있음
    }

    // Case 1: App Links가 /auth/callback?code=... 를 가로챈 경우
    // 서버에 도달하기 전이므로 클라이언트에서 직접 code exchange
    const urlObj = new URL(url);
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
  });
}
