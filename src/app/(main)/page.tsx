import { Suspense } from "react";
import HomeClientShell from "@/components/home/HomeClientShell";
import type { HomeGame } from "@/hooks/useHomeInit";
import { PRESEASON_DATES } from "@/lib/constants/preseason-schedule";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { fetchHomeLiveGames } from "@/lib/crawler/home-live-games";

// Force dynamic rendering — game data changes throughout the day
export const dynamic = "force-dynamic";
export const revalidate = 30; // ISR: revalidate every 30s

/**
 * Server-side: games + live 데이터를 한번에 fetch.
 * 기존 2회 클라이언트 호출(games + game-live) → 서버 1회로 통합.
 */
async function getInitialData(): Promise<{
  games: HomeGame[];
  liveGames: LiveGameData[];
  isPreseason: boolean;
}> {
  try {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const yyyymmdd = dateStr.replace(/-/g, "");

    // 1) 경기 목록
    const gamesData = await fetchGames(yyyymmdd);
    const games: HomeGame[] = gamesData.map((g: { gameId: string; homeTeamId: number; awayTeamId: number; time: string; stadium: string; homeScore?: number | null; awayScore?: number | null; status: string; inning?: number; isTop?: boolean; awayStarterName?: string | null; homeStarterName?: string | null; winPitcher?: string | null; losePitcher?: string | null; broadcastChannels?: HomeGame["broadcastChannels"] }) => ({
      id: g.gameId,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      time: g.time,
      stadium: g.stadium,
      homeScore: g.homeScore ?? 0,
      awayScore: g.awayScore ?? 0,
      status: g.status as HomeGame["status"],
      inning: g.status === "live" ? `${g.inning}회${g.isTop ? "초" : "말"}` : null,
      awayStarterName: g.awayStarterName ?? null,
      homeStarterName: g.homeStarterName ?? null,
      winPitcher: g.winPitcher ?? null,
      losePitcher: g.losePitcher ?? null,
      broadcastChannels: g.broadcastChannels,
    }));

    // 2) 라이브 데이터 (KBO GameList — BSO/주자/타자/투수 포함). bounded + 실패/열화 시
    // 경기목록(gamesData, Naver 폴백 포함)에서 합성 — KBO blackhole 에도 홈 SSR 이 hang 안 함.
    const liveGames: LiveGameData[] = await fetchHomeLiveGames(yyyymmdd, gamesData);

    return { games, liveGames, isPreseason: PRESEASON_DATES.includes(dateStr) };
  } catch {
    return { games: [], liveGames: [], isPreseason: false };
  }
}

export default async function HomePage() {
  const { games, liveGames, isPreseason } = await getInitialData();

  return (
    <Suspense>
      <HomeClientShell
        initialGames={games}
        initialLiveGames={liveGames}
        initialIsPreseason={isPreseason}
      />
    </Suspense>
  );
}
