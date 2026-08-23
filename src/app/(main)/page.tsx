import { Suspense } from "react";
import HomeClientShell from "@/components/home/HomeClientShell";
import type { HomeGame } from "@/hooks/useHomeInit";
import { PRESEASON_DATES } from "@/lib/constants/preseason-schedule";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import { fetchGamesUserFacing } from "@/lib/crawler/games-user-facing";
import { liveGamesFromKboGames } from "@/lib/crawler/home-live-games";

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

    // 1) 경기 목록 — 유저 대면 하이브리드: Naver primary(스코어/이닝) + KBO enrich(BSO/주자/투타).
    // KBO 열화여도 빠르게 수렴하고, KBO 살아있으면 라이브 상세까지 보존.
    const gamesData = await fetchGamesUserFacing(yyyymmdd);
    const games: HomeGame[] = gamesData.map((g: { gameId: string; homeTeamId: number; awayTeamId: number; time: string; stadium: string; homeScore?: number | null; awayScore?: number | null; status: string; inning?: number; isTop?: boolean; awayStarterName?: string | null; homeStarterName?: string | null; winPitcher?: string | null; losePitcher?: string | null; cancelReason?: string | null; broadcastChannels?: HomeGame["broadcastChannels"] }) => ({
      id: g.gameId,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      time: g.time,
      stadium: g.stadium,
      homeScore: g.homeScore ?? 0,
      awayScore: g.awayScore ?? 0,
      status: g.status as HomeGame["status"],
      // 취소 사유 — 홈 초기 진입(SSR)이 이걸 버리면, useHomeInit 은 initialGames 가 있을 때
      // 클라이언트 재조회를 건너뛰므로 첫 화면이 영영 고정 문구로 남는다(삼순 NO-GO ①).
      cancelReason: g.status === "cancelled" ? (g.cancelReason ?? null) : null,
      inning: g.status === "live" ? `${g.inning}회${g.isTop ? "초" : "말"}` : null,
      awayStarterName: g.awayStarterName ?? null,
      homeStarterName: g.homeStarterName ?? null,
      winPitcher: g.winPitcher ?? null,
      losePitcher: g.losePitcher ?? null,
      broadcastChannels: g.broadcastChannels,
    }));

    // 2) 라이브 데이터 — 경기목록에서 순수 변환(2차 KBO 직호출 제거). fetchGames 응답에
    // BSO/주자/현재 투타가 이미 포함되어 있고, Naver 폴백 시엔 graceful degrade.
    const liveGames: LiveGameData[] = liveGamesFromKboGames(gamesData);

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
