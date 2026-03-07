"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "./client";
import type { User, Session } from "@supabase/supabase-js";

interface Profile {
  id: string;
  nickname: string;
  team_id: number;
  favorite_players: any[];
  points: number;
  grade: string;
  avatar_url: string | null;
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

  async function loadProfile(userId: string) {
    try {
      // 1차: 클라이언트 직접 조회
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();

      if (!error && data) {
        setProfile(data);
        return;
      }

      // 1차 실패 원인 로깅 (RLS 403 vs row없음 PGRST116 vs 네트워크)
      console.warn("[AuthContext] client profile fetch failed:", {
        code: error?.code,
        message: error?.message,
        status: (error as Record<string, unknown>)?.status,
        userId,
      });

      // 2차: 서버사이드 API로 fallback (OAuth 직후 클라이언트 auth 전파 안 된 경우)
      const res = await fetch("/api/me", { credentials: "include" });
      if (res.ok) {
        const json = await res.json();
        if (json.profile) {
          setProfile(json.profile);
          return;
        }
      }

      setProfile(null);
    } catch {
      setProfile(null);
    }
  }

  async function refreshProfile() {
    if (user) await loadProfile(user.id);
  }

  useEffect(() => {
    async function syncSession() {
      const { data: { session } } = await supabase.auth.getSession();
      // user는 즉시 세팅 (auth truth). profile은 별도 비동기.
      setUser(session?.user ?? null);
      if (session?.user) {
        await loadProfile(session.user.id);
      } else {
        setProfile(null);
      }
      setLoading(false);
    }

    // 초기 세션 확인
    syncSession();

    // 인증 상태 변화 구독
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        // user는 즉시 세팅. profile 로드 실패해도 user는 유지.
        setUser(session?.user ?? null);
        if (session?.user) {
          await loadProfile(session.user.id);
        } else {
          setProfile(null);
        }
        setLoading(false);
      }
    );

    // iOS PWA: OAuth가 SFSafariViewController에서 완료된 후
    // 사용자가 PWA로 돌아오면 세션을 재확인해야 함
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
        await supabase.auth.signOut();
        // Force full reload to clear all client state (PWA included)
        window.location.href = "/";
      },
      refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
