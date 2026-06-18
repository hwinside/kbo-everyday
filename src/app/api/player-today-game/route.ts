import { NextRequest, NextResponse } from "next/server";
import { fetchGames, fetchBoxScore } from "@/lib/crawler/kbo-api";
import { getKSTToday } from "@/lib/utils/date-kst";
import { getTeamById } from "@/lib/constants/teams";

// 선수 '오늘 경기 활약' — 팀의 당일 경기 박스스코어에서 해당 선수 라인 추출.
// 라이브/종료 모두 박스스코어로 커버. 경기 전(scheduled)·경기 없음·미출전이면 show:false.
// 노출 윈도우는 getKSTToday() 기준이라 당일 24:00(KST)이 지나면 자연히 사라진다.

interface BatterLine {
  ab: number; h: number; hr: number; rbi: number; runs: number; bb: number; sb: number;
  onBase: number; // 출루 = 안타 + 볼넷 (사구 데이터 없어 근사)
}
interface PitcherLine {
  ip: string; pitches: number; k: number; bb: number; hits: number; runs: number; er: number;
  decision: string; // 승/패/세/홀 등
}

export interface PlayerTodayGameResponse {
  show: boolean;
  status: "live" | "final" | "scheduled" | "cancelled" | "none";
  isLive: boolean;
  opponentName: string | null;
  type: "batter" | "pitcher";
  batter?: BatterLine;
  pitcher?: PitcherLine;
}

const HIDDEN = (status: PlayerTodayGameResponse["status"], type: PlayerTodayGameResponse["type"]): PlayerTodayGameResponse => ({
  show: false, status, isLive: false, opponentName: null, type,
});

export async function GET(req: NextRequest) {
  const teamId = parseInt(req.nextUrl.searchParams.get("team") ?? "", 10);
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim();
  const pos = req.nextUrl.searchParams.get("pos") ?? "";
  const type: PlayerTodayGameResponse["type"] = pos.includes("투수") ? "pitcher" : "batter";

  if (!teamId || !name) {
    return NextResponse.json(HIDDEN("none", type), { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const date = getKSTToday().replace(/-/g, "");
    const games = await fetchGames(date);
    const game = games.find((g) => g.awayTeamId === teamId || g.homeTeamId === teamId);

    if (!game) return NextResponse.json(HIDDEN("none", type), { headers: { "Cache-Control": "s-maxage=60" } });
    if (game.status === "scheduled" || game.status === "cancelled") {
      return NextResponse.json(HIDDEN(game.status, type), { headers: { "Cache-Control": "s-maxage=60" } });
    }

    const box = await fetchBoxScore(game.gameId);
    if (!box) return NextResponse.json(HIDDEN(game.status, type), { headers: { "Cache-Control": "s-maxage=20" } });

    const isHome = game.homeTeamId === teamId;
    const opponentName = getTeamById(isHome ? game.awayTeamId : game.homeTeamId)?.shortName ?? null;
    const isLive = game.status === "live";

    if (type === "pitcher") {
      const row = (isHome ? box.homePitchers : box.awayPitchers).find((p) => p.name.trim() === name);
      if (!row) return NextResponse.json(HIDDEN(game.status, type), { headers: { "Cache-Control": "s-maxage=20" } });
      const pitcher: PitcherLine = {
        ip: row.inningsPitched, pitches: row.pitchCount, k: row.strikeouts, bb: row.walks,
        hits: row.hits, runs: row.runs, er: row.earnedRuns, decision: row.decision ?? "",
      };
      const res: PlayerTodayGameResponse = { show: true, status: game.status, isLive, opponentName, type, pitcher };
      return NextResponse.json(res, { headers: { "Cache-Control": "s-maxage=20, stale-while-revalidate=40" } });
    }

    const row = (isHome ? box.homeBatters : box.awayBatters).find((b) => b.name.trim() === name);
    if (!row) return NextResponse.json(HIDDEN(game.status, type), { headers: { "Cache-Control": "s-maxage=20" } });
    const batter: BatterLine = {
      ab: row.atBats, h: row.hits, hr: row.hr, rbi: row.rbi, runs: row.runs, bb: row.bb, sb: row.sb,
      onBase: row.hits + row.bb,
    };
    const res: PlayerTodayGameResponse = { show: true, status: game.status, isLive, opponentName, type, batter };
    return NextResponse.json(res, { headers: { "Cache-Control": "s-maxage=20, stale-while-revalidate=40" } });
  } catch {
    return NextResponse.json(HIDDEN("none", type), { status: 200, headers: { "Cache-Control": "no-store" } });
  }
}
