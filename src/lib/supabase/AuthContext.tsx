"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "./client";
import { setMyTeamId } from "@/lib/store/myteam";
import { setFavoritePlayers } from "@/lib/store/favorites";
import { setOnboardingStatus } from "@/lib/store/onboarding";
import { registerDeepLinkListener } from "@/lib/capacitor/auth";
import type { User } from "@supabase/supabase-js";
import type { FavoritePlayer } from "@/lib/store/favorites";

interface Profile {
  id: string;
  nickname: string;
  team_id: number;
  favorite_players: FavoritePlayer[];
  points: number;
  grade: string;
  avatar_url: string | null;
  invited_by: string | null;
  is_operator?: boolean | null;
}

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: null,
  loading: true,
  signOut: async () => {},
  refreshProfile: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  function syncProfileToLocal(p: Profile) {
    // 로그인 시 DB 프로필 → localStorage 강제 동기화 (DB = source of truth)
    if (p.team_id) {
      setMyTeamId(p.team_id);
      // 팀이 있으면 온보딩 완료 상태도 복원 (PWA 재설치 시 localStorage 초기화 대응)
      setOnboardingStatus(p.favorite_players?.length ? "completed" : "skipped");
    }
    // DB에 최애선수 있으면 복원, 없으면 게스트 값 제거
    setFavoritePlayers(p.favorite_players?.length ? p.favorite_players : []);
  }

  async function loadProfile(accessToken: string, userId: string) {
    // 1차: 서버 API (Bearer 토큰 + service role — 가장 안정적)
    try {
      const res = await fetch("/api/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const json = await res.json();
        if (json.profile) {
          setProfile(json.profile);
          syncProfileToLocal(json.profile);
          return;
        }
      }
    } catch { /* continue to fallback */ }

    // 2차: Supabase REST API 직접 호출 (access_token 명시 전달)
    try {
      const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`;
      const res = await fetch(url, {
        headers: {
          apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (res.ok) {
        const rows = await res.json();
        const data = Array.isArray(rows) ? rows[0] : null;
        if (data && data.id) {
          setProfile(data);
          syncProfileToLocal(data);
          return;
        }
      }
    } catch { /* continue */ }

    // 3차: Supabase 클라이언트 직접 (최후 fallback)
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .maybeSingle();
      if (!error && data) {
        setProfile(data);
        syncProfileToLocal(data);
      } else {
        // 1회 retry (1초 후) - 네트워크 일시 실패 대비
        console.warn("[AuthContext] profile load failed, retrying in 1s...", error?.message);
        await new Promise(r => setTimeout(r, 1000));
        const retry = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
        if (!retry.error && retry.data) {
          setProfile(retry.data);
          syncProfileToLocal(retry.data);
        } else {
          setProfile(null);
        }
      }
    } catch {
      setProfile(null);
    }
  }

  async function refreshProfile() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user && session.access_token) {
      await loadProfile(session.access_token, session.user.id);
    }
  }

  useEffect(() => {
    async function syncSession() {
      let session: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] = null;

      // 1차: 일반 세션 (쿠키 기반)
      try {
        const result = await supabase.auth.getSession();
        session = result.data.session;
      } catch { /* getSession fail */ }

      // 2차: sessionStorage에 pending token이 있으면 setSession으로 복원
      // (iOS Safari에서 쿠키가 안 붙을 때의 fallback)
      if (!session && typeof window !== "undefined") {
        try {
          const pending = sessionStorage.getItem("kbo-pending-session");
          if (pending) {
            const { access_token, refresh_token } = JSON.parse(pending);
            if (access_token && refresh_token) {
              const { data } = await supabase.auth.setSession({
                access_token,
                refresh_token,
              });
              session = data.session;
            }
            // 사용 후 제거 (1회성)
            sessionStorage.removeItem("kbo-pending-session");
          }
        } catch { sessionStorage.removeItem("kbo-pending-session"); }
      }

      setUser(session?.user ?? null);
      if (session?.user && session.access_token) {
        // 계정 전환 감지 (syncSession 경로)
        try {
          const prevId = localStorage.getItem('kbo-auth-uid');
          if (prevId && prevId !== session.user.id) {
            ['kbo-my-team', 'kbo-onboarding-status', 'kbo-favorite-players'].forEach(k => localStorage.removeItem(k));
            sessionStorage.clear();
          }
          localStorage.setItem('kbo-auth-uid', session.user.id);
        } catch { /* SSR safety */ }
        await loadProfile(session.access_token, session.user.id);
      } else {
        setProfile(null);
      }
      setLoading(false);
    }

    syncSession();

    // Capacitor: OAuth 콜백 deep link 수신 → setSession() → onAuthStateChange 자동 트리거
    registerDeepLinkListener();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setUser(session?.user ?? null);
        if (session?.user && session.access_token) {
          // 계정 전환 감지: userId가 바뀌면 이전 계정 localStorage 즉시 정리
          try {
            const prevId = localStorage.getItem('kbo-auth-uid');
            if (prevId && prevId !== session.user.id) {
              ['kbo-my-team', 'kbo-onboarding-status', 'kbo-favorite-players'].forEach(k => localStorage.removeItem(k));
              sessionStorage.clear();
            }
            localStorage.setItem('kbo-auth-uid', session.user.id);
          } catch { /* SSR safety */ }

          await loadProfile(session.access_token, session.user.id);

          // Google Ads 전환은 ProfileSetupModal.handleComplete()에서 발화함
          // (닉네임+팀 선택 완료 시점 = 실제 회원가입 완료)
        } else {
          setProfile(null);
        }
        setLoading(false);
      }
    );

    // iOS PWA: OAuth 완료 후 PWA 복귀 시 세션 재확인
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        syncSession();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      subscription.unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      profile,
      loading,
      signOut: async () => {
        // 네이티브 auth 락이 멈추면 signOut()이 영구 hang → 이후 정리/이동이 안 돼
        // 로그아웃 버튼이 "안 먹는" 것처럼 보인다. 타임아웃을 걸어 락 hang과 무관하게
        // 항상 로컬 정리 + 홈 이동이 실행되도록 보장한다. (#209/#419 네이티브 hang 패턴)
        try {
          await Promise.race([
            supabase.auth.signOut(),
            new Promise(resolve => setTimeout(resolve, 2500)),
          ]);
        } catch { /* ignore */ }
        // 계정 전환 시 이전 계정 localStorage 잔존 방지
        try {
          const keysToRemove = ['kbo-my-team', 'kbo-onboarding-status', 'kbo-favorite-players'];
          keysToRemove.forEach(k => localStorage.removeItem(k));
          // welcome toast / gads conversion 등 session 키도 정리
          sessionStorage.clear();
          // signOut()이 락 hang으로 세션 토큰을 못 지웠을 수 있어 supabase auth 쿠키를 직접 만료.
          // (sb-<ref>-auth-token 형식 — 안 지우면 로그아웃 후에도 로그인 상태로 남음)
          document.cookie.split(";").forEach(c => {
            const name = c.split("=")[0].trim();
            if (name.startsWith("sb-")) {
              document.cookie = `${name}=; Max-Age=0; path=/`;
            }
          });
        } catch { /* SSR safety */ }
        window.location.href = "/";
      },
      refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
