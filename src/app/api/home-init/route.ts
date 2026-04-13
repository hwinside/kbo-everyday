import { NextResponse } from "next/server";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import type { KboRawGame } from "@/types/api";

/**
 * GET /api/home-init?date=YYYYMMDD
 * 오늘 경기목록 + 라이브 상태를 하나의 응답으로 통합.
 * 클라이언트 워터폴 제거: 기존 /api/games + /api/game-live 2회 → 1회
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const now = new Date();
  const defaultDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const date = url.searchParams.get("date") || defaultDate;

  if (!/^\d{8}$/.test(date)) {
    return NextResponse.json({ error: "date param must be YYYYMMDD" }, { status: 400 });
  }

  try {
    // 1) 경기 목록 (fetchGames — KBO API)
    const gamesData = await fetchGames(date);

    // 2) 라이브 데이터 (KBO GameList — 동일 소스이므로 추가 호출 불필요)
    //    game-live 로직 인라인: KBO GetKboGameList로 BSO/주자/타자/투수 포함
    let liveGames: Record<string, unknown>[] = [];
    try {
      const res = await fetch("https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${date}`,
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
          };
        });
      }
    } catch {
      // live data fetch 실패해도 games만으로 진행
    }

    // 경기시간대 여부로 캐시 차등
    const hour = new Date().getHours();
    const isGameTime = hour >= 11 && hour <= 24;
    const sMaxAge = isGameTime ? 15 : 60;

    return NextResponse.json({
      date,
      games: gamesData,
      liveGames,
    }, {
      headers: {
        "Cache-Control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge * 2}`,
      },
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message, games: [], liveGames: [] }, { status: 200 });
  }
}
