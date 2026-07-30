import { NextRequest, NextResponse } from "next/server";
import type { KboRawGame } from "@/types/api";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { resolveGameLiveDate } from "@/lib/game-live-date";
import { isKboGameCancelled } from "@/lib/crawler/kbo-status";
import { fetchKboLiveGames } from "@/lib/notifications/kbo-live-games";

const __diagSeenPitchers = new Set<string>();

function diagMissingPitcherPhoto(pitcherName: string | null, gameId: string) {
  if (!pitcherName) return;
  if (PLAYER_PHOTO_MAP[pitcherName]) return;
  if (!/^[가-힣]+$/.test(pitcherName)) return;
  if (__diagSeenPitchers.has(pitcherName)) return;
  __diagSeenPitchers.add(pitcherName);
  const codepoints = [...pitcherName].map(c => c.codePointAt(0)!.toString(16)).join(" ");
  const utf8 = Buffer.from(pitcherName, "utf-8").toString("hex");
  console.warn(
    `[diag/missing-pitcher-photo] gameId=${gameId} name=${JSON.stringify(pitcherName)} ` +
      `len=${pitcherName.length} codepoints=${codepoints} utf8=${utf8}`
  );
}

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") || resolveGameLiveDate();
  
  try {
    const fetched = await fetchKboLiveGames(date, Date.now() + 5_000);
    if (!fetched.ok) throw new Error("dual-source live games unavailable");
    const games = fetched.games.map((g: KboRawGame) => {
      const status = isKboGameCancelled(g.CANCEL_SC_ID) ? "cancelled"
        : g.GAME_STATE_SC === "3" ? "final"
        : g.GAME_STATE_SC === "2" ? "live"
        : "scheduled";
      const resolvedPlayers = resolveCurrentPlayers({
        tPlayerName: g.T_P_NM,
        bPlayerName: g.B_P_NM,
        gameTbSc: g.GAME_TB_SC,
      });
      if (status === "live") {
        diagMissingPitcherPhoto(resolvedPlayers.currentPitcher, g.G_ID);
      }
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
        ...resolvedPlayers,
        date: g.G_DT,
        stadium: g.S_NM,
        status,
        currentInning: g.GAME_INN_NO ? `${g.GAME_INN_NO}회${g.GAME_TB_SC === "T" ? "초" : "말"}` : "",
        isLive: g.GAME_STATE_SC === "2",
        time: g.G_TM || "",
        awayStarterName: g.T_PIT_P_NM?.trim() || null,
        homeStarterName: g.B_PIT_P_NM?.trim() || null,
      };
    });

    return NextResponse.json({ games, date });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message, games: [] }, { status: 200 });
  }
}
