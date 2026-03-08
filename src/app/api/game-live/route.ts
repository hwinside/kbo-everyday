import { NextRequest, NextResponse } from "next/server";
import type { KboRawGame } from "@/types/api";

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
    const games = (data?.game || []).map((g: KboRawGame) => ({
      gameId: g.G_ID,
      awayName: g.AWAY_NM,
      homeName: g.HOME_NM,
      awayScore: parseInt(g.AWAY_SCORE) || 0,
      homeScore: parseInt(g.HOME_SCORE) || 0,
      inning: parseInt(g.INN_NO) || 0,
      isTop: g.TB_SC === "T",
      balls: parseInt(g.BALL_CN) || 0,
      strikes: parseInt(g.STRIKE_CN) || 0,
      outs: parseInt(g.OUT_CN) || 0,
      runner1b: !!g.BASE1_NM,
      runner2b: !!g.BASE2_NM,
      runner3b: !!g.BASE3_NM,
      runner1bName: g.BASE1_NM || null,
      runner2bName: g.BASE2_NM || null,
      runner3bName: g.BASE3_NM || null,
      currentBatter: g.BAT_NM || null,
      currentPitcher: g.PIT_NM || null,
      date: g.G_DT,
      stadium: g.STADIUM_NM,
      currentInning: g.INN_NO ? `${g.INN_NO}회${g.TB_SC === "T" ? "초" : "말"}` : "",
      isLive: parseInt(g.INN_NO) > 0,
    }));

    return NextResponse.json({ games, date });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message, games: [] }, { status: 200 });
  }
}
