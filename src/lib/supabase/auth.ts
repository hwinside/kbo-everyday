import { supabase } from "./client";

// Always use the canonical domain for OAuth callbacks.
// In iOS PWA, window.location.origin can be correct but the OAuth flow
// opens in SFSafariViewController which won't return to the PWA context.
// Hardcoding ensures we always land on keubo.fan.
const CALLBACK_URL = "https://keubo.fan/auth/callback";

/** 구글 로그인 — PWA 동일 탭에서 OAuth 진행 (Safari VC 방지) */
export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: CALLBACK_URL,
      skipBrowserRedirect: true,
      queryParams: {
        prompt: "select_account",
      },
    },
  });
  if (data?.url) {
    window.location.assign(data.url);
  }
  return { data, error };
}

/** 네이버 로그인 — Supabase Custom OIDC provider */
export async function signInWithNaver() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "custom:naver-login" as any,
    options: {
      redirectTo: CALLBACK_URL,
      skipBrowserRedirect: true,
    },
  });
  if (data?.url) {
    window.location.assign(data.url);
  }
  return { data, error };
}

/** 카카오 로그인 — PWA 동일 탭에서 OAuth 진행 (Safari VC 방지) */
export async function signInWithKakao() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "kakao",
    options: {
      redirectTo: CALLBACK_URL,
      skipBrowserRedirect: true,
    },
  });
  if (data?.url) {
    window.location.assign(data.url);
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
