import { Suspense } from "react";
import HomeClientShell from "@/components/home/HomeClientShell";
import type { HomeGame } from "@/hooks/useHomeInit";
import { PRESEASON_DATES } from "@/lib/constants/preseason-schedule";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import { fetchGames } from "@/lib/crawler/kbo-api";
import type { KboRawGame } from "@/types/api";

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
    const games: HomeGame[] = gamesData.map((g: { gameId: string; homeTeamId: number; awayTeamId: number; time: string; stadium: string; homeScore?: number | null; awayScore?: number | null; status: string; inning?: number; isTop?: boolean; awayStarterName?: string | null; homeStarterName?: string | null; winPitcher?: string | null; losePitcher?: string | null }) => ({
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
    }));

    // 2) 라이브 데이터 (KBO GameList — BSO/주자/타자/투수 포함)
    let liveGames: LiveGameData[] = [];
    try {
      // 2026-05-20: KBO가 Referer가 koreabaseball.com이 아닌 요청을 IE 에러 페이지로 막음.
      const res = await fetch("https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
          "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
        },
        body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${yyyymmdd}`,
        next: { revalidate: 10 },
      });
      if (res.ok) {
        const data = await res.json();
        liveGames = (data?.game || []).map((g: KboRawGame) => {
          const status = g.CANCEL_SC_ID !== "0" ? "cancelled"
            : g.GAME_STATE_SC === "3" ? "final"
            : g.GAME_STATE_SC === "2" ? "live"
            : "scheduled";
          return {
            gameId: g.G_ID,
            awayName: g.AWAY_NM,
            homeName: g.HOME_NM,
            awayScore: status !== "scheduled" ? parseInt(g.T_SCORE_CN) || 0 : 0,
            homeScore: status !== "scheduled" ? parseInt(g.B_SCORE_CN) || 0 : 0,
            inning: g.GAME_INN_NO ?? 0,
            isTop: g.GAME_TB_SC === "T",
            balls: g.BALL_CN ?? 0,
            strikes: g.STRIKE_CN ?? 0,
            outs: g.OUT_CN ?? 0,
            runner1b: (g.B1_BAT_ORDER_NO ?? 0) > 0,
            runner2b: (g.B2_BAT_ORDER_NO ?? 0) > 0,
            runner3b: (g.B3_BAT_ORDER_NO ?? 0) > 0,
            runner1bOrder: g.B1_BAT_ORDER_NO ?? 0,
            runner2bOrder: g.B2_BAT_ORDER_NO ?? 0,
            runner3bOrder: g.B3_BAT_ORDER_NO ?? 0,
            runner1bName: null,
            runner2bName: null,
            runner3bName: null,
            ...resolveCurrentPlayers({
              tPlayerName: g.T_P_NM,
              bPlayerName: g.B_P_NM,
              gameTbSc: g.GAME_TB_SC,
            }),
            date: g.G_DT,
            stadium: g.S_NM,
            status,
            currentInning: g.GAME_INN_NO ? `${g.GAME_INN_NO}회${g.GAME_TB_SC === "T" ? "초" : "말"}` : "",
            isLive: g.GAME_STATE_SC === "2",
            awayStarterName: g.T_PIT_P_NM?.trim() || null,
            homeStarterName: g.B_PIT_P_NM?.trim() || null,
          } as LiveGameData;
        });
      }
    } catch {
      // live data fetch 실패해도 games만으로 진행
    }

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
