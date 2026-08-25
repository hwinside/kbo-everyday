"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "./client";
import { setMyTeamId } from "@/lib/store/myteam";
import { setFavoritePlayers } from "@/lib/store/favorites";
import { setOnboardingStatus } from "@/lib/store/onboarding";
import { clearUserScopedStores } from "@/lib/store/user-scope";
import { commitAuthIdentity, beginAuthDispatch, commitAuthIdentityIfCurrent } from "@/lib/supabase/auth-identity";
import { registerDeepLinkListener } from "@/lib/capacitor/auth";
import {
  acquireSession,
  backupSessionTokens,
  beginLogoutFence,
  clearSessionBackup,
} from "@/lib/capacitor/session-backup";
import { createProfileLoadLedger } from "@/lib/client-dedupe";
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

// ── /api/me dedupe 상태 (모듈 스코프 — AuthProvider는 앱에 1회 마운트) ──────────────
// loadProfile은 부팅 syncSession + onAuthStateChange(INITIAL_SESSION/TOKEN_REFRESHED/
// SIGNED_IN) + visibilitychange 복귀마다 호출돼 같은 유저 프로필을 반복 조회한다
// (observability 실측: /api/me 218K/24h). 같은 유저로 이미 성공 로드했고 TTL 내면
// skip, 동시 호출은 in-flight promise 공유. 명시 갱신(refreshProfile)은 force로 우회.
// 삼순 #1253 blocker①: generation fencing — no-session/로그아웃은 invalidate()로 장부를
// 비우고, force는 세대를 올려 늦은 옛 응답이 최신 profile을 덮지 못하게 한다.
const PROFILE_TTL_MS = 10 * 60 * 1000; // 10분 — 타기기 변경 반영 지연 상한
const profileLedger = createProfileLoadLedger(PROFILE_TTL_MS);

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

  async function loadProfile(accessToken: string, userId: string, opts?: { force?: boolean }) {
    return profileLedger.load(userId, opts?.force === true, (isCurrent) =>
      loadProfileNow(accessToken, userId, isCurrent));
  }

  /** 실제 프로필 조회(3단 fallback). 프로필을 성공적으로 set했으면 true.
   *  isCurrent(): ledger 세대 가드 — 늦게 도착한 옛 응답이 force 갱신 결과나
   *  다른 유저 상태를 덮지 못하게 모든 setProfile 적용 직전에 확인한다. */
  async function loadProfileNow(accessToken: string, userId: string, isCurrent: () => boolean): Promise<boolean> {
    // 1차: 서버 API (Bearer 토큰 + service role — 가장 안정적)
    try {
      const res = await fetch("/api/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const json = await res.json();
        if (json.profile) {
          if (!isCurrent()) return false; // 세대 교체됨 — 옛 응답 폐기
          setProfile(json.profile);
          syncProfileToLocal(json.profile);
          return true;
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
          if (!isCurrent()) return false; // 세대 교체됨 — 옛 응답 폐기
          setProfile(data);
          syncProfileToLocal(data);
          return true;
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
        if (!isCurrent()) return false; // 세대 교체됨 — 옛 응답 폐기
        setProfile(data);
        syncProfileToLocal(data);
        return true;
      } else {
        // 1회 retry (1초 후) - 네트워크 일시 실패 대비
        console.warn("[AuthContext] profile load failed, retrying in 1s...", error?.message);
        await new Promise(r => setTimeout(r, 1000));
        const retry = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
        if (!retry.error && retry.data) {
          if (!isCurrent()) return false; // 세대 교체됨 — 옛 응답 폐기
          setProfile(retry.data);
          syncProfileToLocal(retry.data);
          return true;
        } else {
          if (isCurrent()) setProfile(null);
        }
      }
    } catch {
      if (isCurrent()) setProfile(null);
    }
    return false;
  }

  async function refreshProfile() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user && session.access_token) {
      // 명시 갱신(프로필 편집 직후 등) — dedupe 캐시 우회
      await loadProfile(session.access_token, session.user.id, { force: true });
    }
  }

  useEffect(() => {
    async function syncSession() {
      // 세션 획득 사다리: ① 쿠키 → ② pending 토큰 → ③ 네이티브 백업 복원.
      // 기존 1·2차 로직을 semantics 그대로 acquireSession 으로 이동 — 상위 단계에서
      // 세션을 얻으면 하위 단계는 실행되지 않는다(정상 로그인 = 네이티브 read 0회,
      // QA 스모크가 call count 로 직접 검증). 웹/플러그인 미포함 바이너리는 ③이 no-op.
      // 늘은 syncSession fence(삼순 7차): async 조회 시작 전 티켓 발급 → 결과 게시 직전
      // 더 최신 auth 이벤트가 왔으면 이 조회 결과를 폐기한다.
      const dispatchTicket = beginAuthDispatch();
      const session = await acquireSession<
        NonNullable<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>
      >({
        getCookieSession: async () => (await supabase.auth.getSession()).data.session,
        consumePendingTokens: () => {
          // (iOS Safari에서 쿠키가 안 붙을 때의 fallback — 사용 후 제거, 1회성)
          if (typeof window === "undefined") return null;
          try {
            const pending = sessionStorage.getItem("kbo-pending-session");
            if (!pending) return null;
            sessionStorage.removeItem("kbo-pending-session");
            const { access_token, refresh_token } = JSON.parse(pending);
            if (access_token && refresh_token) return { access_token, refresh_token };
          } catch { sessionStorage.removeItem("kbo-pending-session"); }
          return null;
        },
        setSession: tokens => supabase.auth.setSession(tokens),
      });

      // 동기 활성 사용자 신원 즉시 갱신(setUser React state는 렌더 뒤 — stale 창 방지)
      // 동기 신원 게시(fence) — 시작 티켓 이후 더 최신 이벤트가 왔으면 폐기하고 setUser·loadProfile도 생략
      if (!commitAuthIdentityIfCurrent(session?.user?.id ?? null, dispatchTicket)) {
        setLoading(false);
        return;
      }
      setUser(session?.user ?? null);
      if (session?.user && session.access_token) {
        // 계정 전환 감지 (syncSession 경로) — 이전 계정 로컬을 공식 clear helper로
        // 정리(실제 키 kbo-favorite-players + 팀 localStorage·cookie 모두).
        try {
          const prevId = localStorage.getItem('kbo-auth-uid');
          if (prevId && prevId !== session.user.id) {
            clearUserScopedStores();
            sessionStorage.clear();
          }
          localStorage.setItem('kbo-auth-uid', session.user.id);
        } catch { /* SSR safety */ }
        await loadProfile(session.access_token, session.user.id);
      } else {
        // 삼순 #1253 blocker①: no-session은 장부도 무효화 — 같은 UID가 TTL 내 재인증되면
        // fresh 마커 때문에 재조회 없이 profile=null로 고정되는 것을 막는다.
        profileLedger.invalidate();
        setProfile(null);
      }
      setLoading(false);
    }

    syncSession();

    // Capacitor: OAuth 콜백 deep link 수신 → setSession() → onAuthStateChange 자동 트리거
    registerDeepLinkListener();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        // 로그인/토큰 갱신마다 네이티브 백업을 최신화 (refresh token rotation 대응).
        // SIGNED_OUT(session=null)에서는 백업을 지우지 않는다 — 일시적 세션 소실에서
        // 백업이 유일한 복구 수단이라, 제거는 명시적 signOut()에서만 수행.
        if (session?.access_token && session.refresh_token) {
          void backupSessionTokens({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
          });
        }
        // 동기 활성 사용자 신원 즉시 갱신 — auth 이벤트 tick에 값 확정(setUser 렌더 전)
        // 동기 신원 권위 게시 — auth 이벤트 tick에 값 확정(revision↑, uid 변경 시 epoch↑)
        commitAuthIdentity(session?.user?.id ?? null);
        setUser(session?.user ?? null);
        if (session?.user && session.access_token) {
          // 계정 전환 감지: userId가 바뀌면 이전 계정 로컬을 공식 clear helper로 즉시 정리
          try {
            const prevId = localStorage.getItem('kbo-auth-uid');
            if (prevId && prevId !== session.user.id) {
              clearUserScopedStores();
              sessionStorage.clear();
            }
            localStorage.setItem('kbo-auth-uid', session.user.id);
          } catch { /* SSR safety */ }

          await loadProfile(session.access_token, session.user.id);

          // Google Ads 전환은 ProfileSetupModal.handleComplete()에서 발화함
          // (닉네임+팀 선택 완료 시점 = 실제 회원가입 완료)
        } else {
          // SIGNED_OUT 포함 no-session — 장부 무효화(동일 UID 재로그인 시 재조회 보장)
          profileLedger.invalidate();
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
        // 명시적 로그아웃 = 네이티브 세션 백업도 제거. fence 를 먼저 올려 signOut 과
        // 동시에 도착하는 TOKEN_REFRESHED/SIGNED_IN 이 백업을 되살리는 race 를 차단하고
        // (이후 backupSessionTokens 전부 no-op), 마지막에 한 번 더 지운다. best-effort.
        beginLogoutFence();
        // 로그아웃 = 활성 사용자 즉시 null(in-flight 저장 응답의 commit 차단)
        commitAuthIdentity(null);
        try { await clearSessionBackup(); } catch { /* ignore */ }
        // 네이티브 auth 락이 멈추면 signOut()이 영구 hang → 이후 정리/이동이 안 돼
        // 로그아웃 버튼이 "안 먹는" 것처럼 보인다. 타임아웃을 걸어 락 hang과 무관하게
        // 항상 로컬 정리 + 홈 이동이 실행되도록 보장한다. (#209/#419 네이티브 hang 패턴)
        try {
          await Promise.race([
            supabase.auth.signOut(),
            new Promise(resolve => setTimeout(resolve, 2500)),
          ]);
        } catch { /* ignore */ }
        // 계정 전환 시 이전 계정 로컬 잔존 방지 — 공식 clear helper(실제 키·팀 cookie 포함)
        try {
          clearUserScopedStores();
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
        // 마지막 재삭제 — signOut 진행 중 끼어든 단계가 백업을 다시 썼을 가능성 방어.
        try { await clearSessionBackup(); } catch { /* ignore */ }
        window.location.href = "/";
      },
      refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
