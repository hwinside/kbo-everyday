import { Suspense } from "react";
import HomeClientShell from "@/components/home/HomeClientShell";
import type { HomeGame } from "@/hooks/useHomeInit";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { PRESEASON_DATES } from "@/lib/constants/preseason-schedule";

// Server Component: 경기 데이터를 서버에서 prefetch → 클라이언트에 전달
// FCP 개선: 경기 목록이 HTML에 포함되어 JS hydration 전에도 레이아웃 확보

// Force dynamic rendering — game data changes throughout the day
export const dynamic = "force-dynamic";
export const revalidate = 30; // ISR: revalidate every 30s

async function getInitialGames(): Promise<{ games: HomeGame[]; isPreseason: boolean }> {
  try {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const yyyymmdd = dateStr.replace(/-/g, "");

    const gamesData = await fetchGames(yyyymmdd);
    const games: HomeGame[] = gamesData.map((g: { gameId: string; homeTeamId: number; awayTeamId: number; time: string; stadium: string; homeScore?: number | null; awayScore?: number | null; status: string; inning?: number; isTop?: boolean }) => ({
      id: g.gameId,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      time: g.time,
      stadium: g.stadium,
      homeScore: g.homeScore ?? 0,
      awayScore: g.awayScore ?? 0,
      status: g.status as HomeGame["status"],
      inning: g.status === "live" ? `${g.inning}회${g.isTop ? "초" : "말"}` : null,
    }));

    return { games, isPreseason: PRESEASON_DATES.includes(dateStr) };
  } catch {
    return { games: [], isPreseason: false };
  }
}

export default async function HomePage() {
  const { games, isPreseason } = await getInitialGames();

  return (
    <Suspense>
      <HomeClientShell initialGames={games} initialIsPreseason={isPreseason} />
    </Suspense>
  );
}
