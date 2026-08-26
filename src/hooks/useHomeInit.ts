import { useState, useEffect, useRef, startTransition } from "react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getFavoritePlayers, setFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import { getMyTeamId } from "@/lib/store/myteam";
import { getOnboardingStatus, setOnboardingStatus } from "@/lib/store/onboarding";
import { saveMyFavorites, ownedRow, ProfileSaveError, type SavedProfileRow } from "@/lib/profile/save-my-profile";
import { getAuthIdentity, isSameAuthIdentity, isAuthIdentityForUser } from "@/lib/supabase/auth-identity";
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
  /** 취소 사유 원문(KBO `CANCEL_SC_NM`). 미수신이면 부재 — "사유 없음"으로 단정하지 않는다. */
  cancelReason?: string | null;
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
  /**
   * 취소 사유 원문(`우천취소`/`폭염취소`/`그라운드사정` 등). status=cancelled 일 때만 유의미.
   * null = 사유를 못 받았다(폴백 경로) — 소비처는 기존 고정 문구로 fallback 한다.
   */
  cancelReason?: string | null;
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
  const [todayGames, setTodayGames] = useState<HomeGame[]>(options?.initialGames ?? []);
  const [isPreseason, setIsPreseason] = useState(options?.initialIsPreseason ?? false);

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
          // 사유는 취소 상태일 때만 실는다(값-플래그 결속) — HomeClientShell.mapApiGame 과 동일 계약.
          cancelReason: g.status === "cancelled" ? (g.cancelReason ?? null) : null,
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
  }, [loading, user, profile]);

  function handleOnboardingComplete(teamId: number, players: FavoritePlayer[]) {
    setMyTeam(teamId);
    setFavPlayers(players);
    setShowOnboarding(false);
    if (players.length === 0) {
      setShowPlayerSetupCTA(true);
    }
  }

  // 2026-08-24 최애선수 설정 유실 수정: 기존에는 fire-and-forget updateProfile이라
  // 저장 실패(만료 토큰 401 등)가 조용히 삼켜져 다음 부팅에서 DB 옛 값으로
  // 롤백됐다. 로그인 유저는 서버 저장 성공 후에만 commit하고, 실패는 CTA 유지
  // + 오류 노출로 바꾼다. seq 가드는 연속 저장 레이스 방지.
  const favSaveSeqRef = useRef(0);

  async function handlePlayerSelect(players: FavoritePlayer[]) {
    setShowPlayerSelect(false);
    const seq = ++favSaveSeqRef.current;
    // 요청 시작 시점 신원 스냅샷{uid,epoch} — commit 직전 동일 epoch 대조(A→B→A·동일 UID 재인증 차단)
    const reqIdentity = getAuthIdentity();
    if (user) {
      // PUT 전 fail-close(삼순 8차): auth 모듈 신원이 현재(uid+epoch)이고 React user.id와
      // uid가 일치할 때만 저장. 전환 중 stale closure(모듈 B / React A)면 저장 안 함.
      if (!isAuthIdentityForUser(reqIdentity, user.id)) return;
      const reqUid = reqIdentity.uid as string;
      const reqSnap = { uid: reqUid, epoch: reqIdentity.epoch };
      let saved;
      try {
        saved = await saveMyFavorites({ favorite_players: players }, reqSnap);
      } catch (e) {
        if (seq !== favSaveSeqRef.current) return; // 더 최신 저장 진행 중 — 이 응답 폐기
        // 계정 전환 가드: 요청 시작 신원과 현재 신원(uid+epoch) 불일치면 실패 commit도 차단(B 로컬·CTA·오알림 오염 방지).
        if (!isSameAuthIdentity(reqSnap)) return;
        // 마지막 성공값(= DB 현재값)이 **현재 계정 소유일 때만** 로컬 정합 —
        // A 성공/B 실패 불일치 방지 + 계정 전환 오염 fail-close.
        const row = e instanceof ProfileSaveError ? ownedRow(e.lastSaved as SavedProfileRow | null, reqUid) : null;
        if (row) {
          const favs = Array.isArray(row.favorite_players) ? row.favorite_players : [];
          setFavoritePlayers(favs);
          setFavPlayers(favs);
          setShowPlayerSetupCTA(favs.length === 0);
          setOnboardingStatus(favs.length ? "completed" : "skipped");
        } else {
          setShowPlayerSetupCTA(true); // 저장 안 됨 — CTA 유지
        }
        alert(e instanceof ProfileSaveError ? e.message : "저장에 실패했어요. 잠시 후 다시 시도해주세요.");
        return;
      }
      if (!saved) return; // superseded — 더 최신 요청이 commit을 담당
      if (seq !== favSaveSeqRef.current) return;
      // 계정 전환 가드: A 200 응답이 B 전환/재인증 뒤 도착하면 동일 epoch가 아니므로 skip
      if (!isSameAuthIdentity(reqSnap)) return;
      // 서버가 반환한 저장된 row(exact)로만 로컬 확정
      const savedPlayers = Array.isArray(saved.favorite_players) ? saved.favorite_players : [];
      setFavoritePlayers(savedPlayers);
      setFavPlayers(savedPlayers);
    } else {
      setFavoritePlayers(players);
      setFavPlayers(players);
    }
    setShowPlayerSetupCTA(false);
    setOnboardingStatus("completed");
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
