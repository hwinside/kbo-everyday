import { useState, useEffect, startTransition } from "react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { isAuthBootstrapPending, readSessionCookieUserId } from "@/lib/supabase/local-session";
import { getFavoritePlayers, setFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import { getMyTeamId } from "@/lib/store/myteam";
import { getOnboardingStatus, setOnboardingStatus } from "@/lib/store/onboarding";
import { updateProfile } from "@/lib/supabase/auth";
import { trackEvent, OnboardingEvents } from "@/lib/analytics";
import { PRESEASON_GAMES, PRESEASON_DATES } from "@/lib/constants/preseason-schedule";
import type { BroadcastChannel } from "@/lib/broadcast-channels";

interface RawGameData {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  time: string;
  stadium: string;
  homeScore?: number;
  awayScore?: number;
  status: "scheduled" | "live" | "final" | "cancelled";
  inning?: string;
  isTop?: boolean;
  awayStarterName?: string | null;
  homeStarterName?: string | null;
  winPitcher?: string | null;
  losePitcher?: string | null;
  broadcastChannels?: BroadcastChannel[];
}

export interface HomeGame {
  id: string;
  homeTeamId: number;
  awayTeamId: number;
  time: string;
  stadium: string;
  homeScore: number;
  awayScore: number;
  status: "scheduled" | "live" | "final" | "cancelled";
  inning: string | null;
  // 팀카드 경기카드 모드용 (예정=예고선발 / 종료=승·패투수). 없으면 미표시.
  awayStarterName?: string | null;
  homeStarterName?: string | null;
  winPitcher?: string | null;
  losePitcher?: string | null;
  // 중계방송사(TV/IPTV). 없으면 미표시.
  broadcastChannels?: BroadcastChannel[];
}

interface UseHomeInitOptions {
  /** 서버에서 prefetch한 경기 데이터 — 있으면 /api/games 재호출 스킵 */
  initialGames?: HomeGame[];
  initialIsPreseason?: boolean;
  /** Pull-to-refresh 트리거. >0으로 바뀌면 서버 prop으로 고정된 오늘 경기를 클라이언트에서 재페치한다. */
  refreshNonce?: number;
}

export function useHomeInit(options?: UseHomeInitOptions) {
  const { user, profile, loading } = useAuth();
  const [myTeamId, setMyTeam] = useState<number | null>(null);
  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showPlayerSelect, setShowPlayerSelect] = useState(false);
  const [showPlayerSetupCTA, setShowPlayerSetupCTA] = useState(false);
  const [welcomeToast, setWelcomeToast] = useState(false);
  // pending-session 복원 완료 감지 시 온보딩 초기화 effect 를 재실행시키는 nonce.
  const [pendingSessionNonce, setPendingSessionNonce] = useState(0);
  const [todayGames, setTodayGames] = useState<HomeGame[]>(options?.initialGames ?? []);
  const [isPreseason, setIsPreseason] = useState(options?.initialIsPreseason ?? false);

  // 로컬 마이팀 즐시 렌더 (2026-08-11 #infra 서비스 속도 트랙):
  // 아래 온보딩 초기화 effect 는 `if (loading) return` 로 인증 확인(세션 복원→
  // profile 페치)이 끝나야 돌아서, 그동안 MY TEAM 카드가 비어 있었다(실기기 수 초).
  // 온보딩을 끝낸 기기는 localStorage 값이 SSOT 이므로 마운트 즐시 그린다.
  // profile 도착 후에는 기존 effect 가 그대로 재조정한다(localTeamId 우선 규칙 동일).
  // 온보딩 미완료(team_selected 등) 상태는 건드리지 않는다 — 기존 분기 유지.
  //
  // 계정 귀속 가드(삼순 리뷰 #1154 NO-GO ①): 계정 전환 직후에는 localStorage 가
  // 이전 계정 것일 수 있다. 세션 쿠키를 동기 판독해 ①비로그인(쿠키 없음)이거나
  // ②쿠키 user id == kbo-auth-uid(로컬 데이터 주인)일 때만 즐시 그린다.
  // 불일치·파싱 실패는 fail-close(기존 인증 흐름 대기) — 오표시 0 이 속도보다 우선.
  useEffect(() => {
    const saved = getMyTeamId();
    const status = getOnboardingStatus();
    if (!saved || !(status === "completed" || status === "skipped")) return;
    // 인증 부트스트랩(pending-session 또는 OAuth hash 복원) 진행 중에는 주인을
    // 확인할 수 없으므로 fail-close(삼순 리뷰 #1154 2차 ①·3차 ① — hash 경로 포함).
    if (isAuthBootstrapPending()) return;
    const cookieUid = readSessionCookieUserId();
    if (cookieUid !== null) {
      // 세션 쿠키가 있다 → 로컬 데이터 주인과 일치할 때만 즐시 렌더.
      const owner = localStorage.getItem("kbo-auth-uid");
      if (cookieUid === "unknown" || !owner || owner !== cookieUid) return;
    }
    setMyTeam(saved);
    setFavPlayers(getFavoritePlayers());
  }, []);

  // 로그인 후 1회 환영 토스트 + 환영 DM
  useEffect(() => {
    if (user && profile?.nickname) {
      const key = `welcome_shown_${user.id}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        startTransition(() => {
          setWelcomeToast(true);
          setTimeout(() => setWelcomeToast(false), 3000);
        });

        // 환영 DM 발송 (서버에서 중복 체크하므로 안전)
        (async () => {
          try {
            const { data: { session } } = await (await import("@/lib/supabase/client")).supabase.auth.getSession();
            if (session?.access_token) {
              await fetch("/api/welcome-dm", {
                method: "POST",
                headers: { Authorization: `Bearer ${session.access_token}` },
              });
            }
          } catch { /* 환영 DM 실패해도 무시 */ }
        })();
      }
    }
  }, [user, profile]);

  // 오늘의 경기 (API + 시범경기 fallback)
  // initialGames가 서버에서 전달되었으면 초기 mount 시에만 클라이언트 재호출 스킵.
  // 단 pull-to-refresh(refreshNonce>0) 때는 서버 prop이 상태로 동기화 안 되므로 다시 페치한다.
  useEffect(() => {
    const nonce = options?.refreshNonce ?? 0;
    if (nonce === 0 && options?.initialGames && options.initialGames.length > 0) return;

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    const yyyymmdd = dateStr.replace(/-/g, "");

    fetch(`/api/games?date=${yyyymmdd}`)
      .then(r => r.json())
      .then(data => {
        const games: HomeGame[] = (data.games ?? []).map((g: RawGameData) => ({
          id: g.gameId,
          homeTeamId: g.homeTeamId,
          awayTeamId: g.awayTeamId,
          time: g.time,
          stadium: g.stadium,
          homeScore: g.homeScore ?? 0,
          awayScore: g.awayScore ?? 0,
          status: g.status,
          inning: g.status === "live" ? `${g.inning}회${g.isTop ? "초" : "말"}` : null,
          // 예고선발(예정)·승·패투수(종료) 보존 — HomeClientShell.mapApiGame과 동일. pull 재페치 시 카드 필드/위젯 snapshot 유지.
          awayStarterName: g.awayStarterName ?? null,
          homeStarterName: g.homeStarterName ?? null,
          winPitcher: g.winPitcher ?? null,
          losePitcher: g.losePitcher ?? null,
          broadcastChannels: g.broadcastChannels,
        }));
        if (games.length > 0) {
          setTodayGames(games);
          setIsPreseason(PRESEASON_DATES.includes(dateStr));
        } else if (PRESEASON_DATES.includes(dateStr)) {
          const TEAM_ID: Record<string, number> = { LG:1, "두산":2, KT:3, SSG:4, NC:5, KIA:6, "롯데":7, "삼성":8, "한화":9, "키움":10 };
          const preGames = PRESEASON_GAMES
            .filter(g => g.date === dateStr)
            .map((g, i) => ({
              id: `pre-${dateStr}-${i}`,
              homeTeamId: TEAM_ID[g.home] ?? 0,
              awayTeamId: TEAM_ID[g.away] ?? 0,
              time: "13:00",
              stadium: g.venue,
              homeScore: 0,
              awayScore: 0,
              status: "scheduled" as const,
              inning: null,
            }));
          setTodayGames(preGames);
          setIsPreseason(true);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.refreshNonce]);

  // team-changed 이벤트 리스닝 (마이페이지에서 구단 변경 시 즉시 반영)
  useEffect(() => {
    const handler = () => {
      const newTeamId = getMyTeamId();
      startTransition(() => setMyTeam(newTeamId));
    };
    window.addEventListener("team-changed", handler);
    return () => window.removeEventListener("team-changed", handler);
  }, []);

  // 온보딩 초기화
  useEffect(() => {
    if (loading) return;
    // 인증 부트스트랩(pending-session 또는 OAuth hash 복원) 중에는 어떤 분기도 타지
    // 않는다(삼순 리뷰 #1154 2차 ①·3차 ①). 복원 전에 loading 이 먼저 false 가 되면
    // saved 분기가 이전 계정의 localStorage 팀을 그려 오표시가 난다(S3/S4 장애주입
    // RED 실측). marker 는 복원 성공/실패 모두 1회성 제거되므로(주석: local-session.ts)
    // 사라질 때까지 200ms 폴링하다 nonce 로 재실행한다. 시간 상한은 두지 않는다 —
    // marker 가 영구 잔존하는 상태는 인증 부트스트랩 자체가 죽은 상태라 홈 렌더를
    // 재개하지 않는 것이 fail-close(오표시 0 우선) 계약이다(삼순 3차 ③: 설명·동작 일치).
    if (isAuthBootstrapPending()) {
      const timer = setInterval(() => {
        if (!isAuthBootstrapPending()) {
          clearInterval(timer);
          setPendingSessionNonce((n) => n + 1);
        }
      }, 200);
      return () => clearInterval(timer);
    }
    startTransition(() => {
      setShowPlayerSetupCTA(false);

      // 온보딩 진행 중(팀 선택 → 선수 선택 사이)이면 어떤 분기도 온보딩을 끊지 않는다.
      // 푸시 권한 다이얼로그 등으로 앱이 inactive↔active 전환되며 이 effect가
      // 재실행될 때 profile 분기가 status를 skipped로 덮어쓰고 온보딩을 숨기던
      // 회귀 방지 (PR #205 리뷰 blocker 1).
      if (getOnboardingStatus() === "team_selected") {
        const savedTeam = getMyTeamId();
        if (savedTeam) {
          setMyTeam(savedTeam);
          setFavPlayers(getFavoritePlayers());
          setShowOnboarding(true);
          return;
        }
      }

      if (profile && profile.team_id) {
        const dbFavs = Array.isArray(profile.favorite_players) ? profile.favorite_players : [];
        // localStorage is updated synchronously in handleTeamChange, so it may be
        // more recent than profile (which requires an async refreshProfile round-trip).
        // Prefer localStorage when it differs — it means the user just changed their team.
        const localTeamId = getMyTeamId();
        const effectiveTeamId = localTeamId ?? profile.team_id;
        setMyTeam(effectiveTeamId);
        setFavPlayers(effectiveTeamId !== profile.team_id ? [] : dbFavs);
        const effectiveFavs = effectiveTeamId !== profile.team_id ? [] : dbFavs;
        setOnboardingStatus(effectiveFavs.length ? "completed" : "skipped");
        setShowOnboarding(false);
        if (effectiveFavs.length === 0) {
          setShowPlayerSetupCTA(true);
        }
        return;
      }

      const saved = getMyTeamId();
      const savedFavs = getFavoritePlayers();
      const rawStatus = typeof window !== "undefined" ? localStorage.getItem("kbo-onboarding-status") : null;
      const status = getOnboardingStatus();

      if (saved && (status === "completed" || status === "skipped")) {
        setMyTeam(saved);
        setFavPlayers(savedFavs);
        setShowOnboarding(false);
        if (status === "skipped" || savedFavs.length === 0) {
          setShowPlayerSetupCTA(true);
        }
        return;
      }

      if (saved && status === "team_selected") {
        setMyTeam(saved);
        setFavPlayers(savedFavs);
        setShowOnboarding(true);
        return;
      }

      if (saved && rawStatus === null) {
        setMyTeam(saved);
        setFavPlayers(savedFavs);
        const recoveredStatus = savedFavs.length > 0 ? "completed" : "skipped";
        setOnboardingStatus(recoveredStatus);
        setShowOnboarding(false);
        if (savedFavs.length === 0) {
          setShowPlayerSetupCTA(true);
        }
        return;
      }

      if (user && !profile) {
        setShowOnboarding(false);
        return;
      }

      setShowOnboarding(true);
    });
  }, [loading, user, profile, pendingSessionNonce]);

  function handleOnboardingComplete(teamId: number, players: FavoritePlayer[]) {
    setMyTeam(teamId);
    setFavPlayers(players);
    setShowOnboarding(false);
    if (players.length === 0) {
      setShowPlayerSetupCTA(true);
    }
  }

  function handlePlayerSelect(players: FavoritePlayer[]) {
    setFavoritePlayers(players);
    setFavPlayers(players);
    setShowPlayerSelect(false);
    setShowPlayerSetupCTA(false);
    setOnboardingStatus("completed");
    if (user) {
      updateProfile(user.id, { favorite_players: players });
    }
    trackEvent(OnboardingEvents.PLAYER_SELECTED, {
      player_count: players.length,
      player_ids: players.map(p => p.playerId),
    });
    // 2026-04-18: ONBOARDING_COMPLETE 를 여기서 발화하면 GA4에 가짜 회원가입 전환으로
    // 누적됨 (이미 가입한 유저가 skip 했다가 나중에 플레이어 고르는 경로).
    // → 별도 이벤트로 분리하고 Google Ads 전환 신호에서는 제외.
    trackEvent(OnboardingEvents.ONBOARDING_PLAYER_UPGRADED, {
      team_id: myTeamId,
      player_count: players.length,
    });
  }

  return {
    user, profile,
    myTeamId,
    favPlayers,
    showOnboarding, setShowOnboarding,
    showPlayerSelect, setShowPlayerSelect,
    showPlayerSetupCTA, setShowPlayerSetupCTA,
    welcomeToast,
    todayGames, isPreseason,
    handleOnboardingComplete,
    handlePlayerSelect,
  };
}
