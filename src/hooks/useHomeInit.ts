import { useState, useEffect } from "react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getFavoritePlayers, setFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import { getMyTeamId } from "@/lib/store/myteam";
import { getOnboardingStatus, setOnboardingStatus } from "@/lib/store/onboarding";
import { updateProfile } from "@/lib/supabase/auth";
import { trackEvent, OnboardingEvents } from "@/lib/analytics";
import { PRESEASON_GAMES, PRESEASON_DATES } from "@/lib/constants/preseason-schedule";

interface RawGameData {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  time: string;
  stadium: string;
  homeScore?: number;
  awayScore?: number;
  status: string;
  inning?: string;
  isTop?: boolean;
}

export interface HomeGame {
  id: string;
  homeTeamId: number;
  awayTeamId: number;
  time: string;
  stadium: string;
  homeScore: number;
  awayScore: number;
  status: "scheduled" | "live" | "final";
  inning: string | null;
}

export function useHomeInit() {
  const { user, profile, loading } = useAuth();
  const [myTeamId, setMyTeam] = useState<number | null>(null);
  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showPlayerSelect, setShowPlayerSelect] = useState(false);
  const [showPlayerSetupCTA, setShowPlayerSetupCTA] = useState(false);
  const [welcomeToast, setWelcomeToast] = useState(false);
  const [todayGames, setTodayGames] = useState<HomeGame[]>([]);
  const [isPreseason, setIsPreseason] = useState(false);

  // 로그인 후 1회 환영 토스트
  useEffect(() => {
    if (user && profile?.nickname) {
      const key = `welcome_shown_${user.id}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        setWelcomeToast(true);
        setTimeout(() => setWelcomeToast(false), 3000);
      }
    }
  }, [user, profile]);

  // 오늘의 경기 (API + 시범경기 fallback)
  useEffect(() => {
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
          status: g.status === "cancelled" ? "final" as const : g.status,
          inning: g.status === "live" ? `${g.inning}회${g.isTop ? "초" : "말"}` : null,
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
  }, []);

  // 온보딩 초기화
  useEffect(() => {
    if (loading) return;
    setShowPlayerSetupCTA(false);

    if (profile && profile.team_id) {
      const dbFavs = Array.isArray(profile.favorite_players) ? profile.favorite_players : [];
      setMyTeam(profile.team_id);
      setFavPlayers(dbFavs);
      setOnboardingStatus(dbFavs.length ? "completed" : "skipped");
      setShowOnboarding(false);
      if (dbFavs.length === 0) {
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
  }, [loading, user, profile]);

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
    trackEvent(OnboardingEvents.ONBOARDING_COMPLETE, {
      team_id: myTeamId,
      player_count: players.length,
      upgraded_from_skip: true,
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
