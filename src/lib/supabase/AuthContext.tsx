"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "./client";
import type { User } from "@supabase/supabase-js";

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

// 임시 디버그 (P0 해결 후 제거)
function debugLog(msg: string) {
  if (typeof window !== "undefined") {
    console.warn("[Auth Debug]", msg);
    // 임시: 화면 하단에 디버그 메시지 표시
    const el = document.getElementById("auth-debug");
    if (el) el.textContent = msg;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadProfile(accessToken: string, userId: string) {
    debugLog(`loadProfile start: token=${accessToken ? "yes(" + accessToken.substring(0, 10) + "...)" : "NO"}, userId=${userId.substring(0, 8)}`);

    // 1차: 서버 API
    try {
      const res = await fetch("/api/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const json = await res.json();
      debugLog(`/api/me: status=${res.status}, profile=${json.profile ? "YES(" + json.profile.nickname + ")" : "null"}, error=${json.error || "none"}`);
      if (res.ok && json.profile) {
        setProfile(json.profile);
        return;
      }
    } catch (e: any) {
      debugLog(`/api/me error: ${e.message}`);
    }

    // 2차: Supabase REST API 직접 호출
    try {
      const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`;
      const res = await fetch(url, {
        headers: {
          apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.pgrst.object+json",
        },
      });
      debugLog(`REST direct: status=${res.status}`);
      if (res.ok) {
        const data = await res.json();
        debugLog(`REST direct data: nickname=${data?.nickname || "null"}`);
        if (data && data.id) {
          setProfile(data);
          return;
        }
      }
    } catch (e: any) {
      debugLog(`REST direct error: ${e.message}`);
    }

    // 3차: Supabase client
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();
      debugLog(`client query: data=${data ? "YES(" + data.nickname + ")" : "null"}, error=${error?.message || "none"}`);
      setProfile(!error && data ? data : null);
    } catch (e: any) {
      debugLog(`client query error: ${e.message}`);
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
      const { data: { session } } = await supabase.auth.getSession();
      debugLog(`syncSession: user=${session?.user?.email || "null"}, hasToken=${!!session?.access_token}`);
      setUser(session?.user ?? null);
      if (session?.user && session.access_token) {
        await loadProfile(session.access_token, session.user.id);
      } else {
        setProfile(null);
      }
      setLoading(false);
    }

    syncSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        debugLog(`authStateChange: event=${event}, user=${session?.user?.email || "null"}, hasToken=${!!session?.access_token}`);
        setUser(session?.user ?? null);
        if (session?.user && session.access_token) {
          await loadProfile(session.access_token, session.user.id);
        } else {
          setProfile(null);
        }
        setLoading(false);
      }
    );

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
        try { await supabase.auth.signOut(); } catch { /* ignore */ }
        window.location.href = "/";
      },
      refreshProfile,
    }}>
      {children}
      {/* 임시 디버그 표시 — P0 해결 후 제거 */}
      <div id="auth-debug" style={{
        position: "fixed", bottom: 60, left: 8, right: 8,
        background: "rgba(0,0,0,0.85)", color: "#0f0", fontSize: 10,
        padding: 6, borderRadius: 6, zIndex: 99999,
        fontFamily: "monospace", wordBreak: "break-all",
        pointerEvents: "none",
      }} />
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
