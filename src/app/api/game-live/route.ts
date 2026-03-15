import { NextRequest, NextResponse } from "next/server";
import type { KboRawGame } from "@/types/api";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") || new Date().toISOString().slice(0, 10).replace(/-/g, "");
  
  try {
    const res = await fetch("https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${date}`,
      next: { revalidate: 30 },
    });

    if (!res.ok) throw new Error(`KBO API ${res.status}`);
    
    const data = await res.json();
    const games = (data?.game || []).map((g: KboRawGame) => {
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

    return NextResponse.json({ games, date });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message, games: [] }, { status: 200 });
  }
}
