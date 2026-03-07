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

  async function loadProfile(userId: string, retries = 2) {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();

      if (error || !data) {
        // OAuth 직후 세션 토큰이 아직 확정 안 된 경우 RLS 실패 가능 → 재시도
        if (retries > 0) {
          await new Promise((r) => setTimeout(r, 500));
          return loadProfile(userId, retries - 1);
        }
        setProfile(null);
      } else {
        setProfile(data);
      }
    } catch {
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 500));
        return loadProfile(userId, retries - 1);
      }
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
