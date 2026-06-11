import { supabase } from "./client";
import { isIOS, isNative } from "@/lib/capacitor/platform";
import { openOAuthInBrowser } from "@/lib/capacitor/auth";

// Always use the canonical domain for OAuth callbacks.
// In iOS PWA, window.location.origin can be correct but the OAuth flow
// opens in SFSafariViewController which won't return to the PWA context.
// Hardcoding ensures we always land on keubo.fan.
const CALLBACK_URL = "https://keubo.fan/auth/callback";
const NATIVE_IOS_CALLBACK_URL = "fan.keubo.app://auth/callback";

function getOAuthCallbackUrl() {
  return isIOS ? NATIVE_IOS_CALLBACK_URL : CALLBACK_URL;
}

/** 구글 로그인 — 네이티브: Custom Tabs, 웹: 동일 탭 OAuth */
export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: getOAuthCallbackUrl(),
      skipBrowserRedirect: true,
      queryParams: {
        prompt: "select_account",
      },
    },
  });
  if (data?.url) {
    if (isNative) {
      await openOAuthInBrowser(data.url);
    } else {
      window.location.assign(data.url);
    }
  }
  return { data, error };
}

/**
 * 네이버 로그인 — 수동 OAuth flow (/api/auth/naver)
 * Supabase Custom OIDC가 openid scope를 강제 추가하는데 네이버는 OIDC 미지원이라
 * GoTrue를 우회하고 직접 OAuth flow를 처리
 */
export async function signInWithNaver() {
  // 서버 API route가 네이버 OAuth URL로 redirect.
  // 네이티브(iOS/Android)는 native 플래그를 넘겨 콜백이 앱으로 세션을 돌려주게 한다.
  // (web은 서버 쿠키로 세션 유지 — 플래그 없음)
  if (isNative) {
    const nativeParam = isIOS ? "ios" : "android";
    await openOAuthInBrowser(`https://keubo.fan/api/auth/naver?native=${nativeParam}`);
  } else {
    window.location.assign("/api/auth/naver");
  }
  return { data: null, error: null };
}

/** Apple 로그인 — iOS 앱스토어 심사 필수 (소셜 로그인 제공 시) */
export async function signInWithApple() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "apple",
    options: {
      redirectTo: getOAuthCallbackUrl(),
      skipBrowserRedirect: true,
    },
  });
  if (data?.url) {
    if (isNative) {
      await openOAuthInBrowser(data.url);
    } else {
      window.location.assign(data.url);
    }
  }
  return { data, error };
}

/** 카카오 로그인 — 네이티브: Custom Tabs, 웹: 동일 탭 OAuth */
export async function signInWithKakao() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "kakao",
    options: {
      redirectTo: getOAuthCallbackUrl(),
      skipBrowserRedirect: true,
    },
  });
  if (data?.url) {
    if (isNative) {
      await openOAuthInBrowser(data.url);
    } else {
      window.location.assign(data.url);
    }
  }
  return { data, error };
}

/** 로그아웃 */
export async function signOut() {
  return supabase.auth.signOut();
}

/** 현재 유저 */
export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/** 프로필 조회/생성 */
export async function getOrCreateProfile(userId: string, defaults?: { nickname: string; teamId: number; favoritePlayers: { playerId: string; name: string; teamId: number; position: string; number: number }[] }) {
  // 조회
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (profile) return profile;

  // 없으면 생성
  if (defaults) {
    const { data, error } = await supabase
      .from("profiles")
      .insert({
        id: userId,
        nickname: defaults.nickname,
        team_id: defaults.teamId,
        favorite_players: defaults.favoritePlayers,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  return null;
}

/** 프로필 업데이트 */
export async function updateProfile(userId: string, updates: {
  nickname?: string;
  team_id?: number;
  favorite_players?: { playerId: string; name: string; teamId: number; position: string; number: number }[];
  avatar_url?: string;
}) {
  return supabase
    .from("profiles")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", userId);
}
