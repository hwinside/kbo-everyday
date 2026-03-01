import { supabase } from "./client";

/** 구글 로그인 */
export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    },
  });
}

/** 카카오 로그인 */
export async function signInWithKakao() {
  return supabase.auth.signInWithOAuth({
    provider: "kakao",
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    },
  });
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
export async function getOrCreateProfile(userId: string, defaults?: { nickname: string; teamId: number; favoritePlayers: any[] }) {
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
  favorite_players?: any[];
  avatar_url?: string;
}) {
  return supabase
    .from("profiles")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", userId);
}
