import { NextRequest, NextResponse } from "next/server";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { getKSTToday } from "@/lib/utils/date-kst";
import { getTeamById } from "@/lib/constants/teams";
import { getGameDetailRouteResult } from "@/lib/services/game-detail";

// 선수 '오늘 경기 활약' — 팀의 당일 경기 박스스코어에서 해당 선수 라인 추출.
// 박스스코어는 game-detail(KBO+네이버 폴백 병합)을 재사용한다.
// ⚠️ KBO fetchBoxScore는 라이브 중 빈 배열을 반환(경기 종료 후에만 채워짐) → 라이브 커버 위해 game-detail 필수.
// 노출 윈도우는 getKSTToday() 기준이라 당일 24:00(KST)이 지나면 자연히 사라진다.

interface BatterLine {
  ab: number; h: number; hr: number; rbi: number; runs: number; bb: number; sb: number;
  onBase: number; // 출루 = 안타 + 볼넷 (사구 데이터 없어 근사)
}
interface PitcherLine {
  ip: string; pitches: number; k: number; bb: number; hits: number; runs: number; er: number; decision: string;
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

interface DetailBatter { name: string; atBats: number; hits: number; hr: number; rbi: number; runs: number; bb: number; sb: number; }
interface DetailPitcher { name: string; inningsPitched: string; pitchCount: number; strikeouts: number; walks: number; hits: number; runs: number; earnedRuns: number; decision: string; }
interface DetailBox { awayBatters: DetailBatter[]; homeBatters: DetailBatter[]; awayPitchers: DetailPitcher[]; homePitchers: DetailPitcher[]; }

const HIDDEN = (status: PlayerTodayGameResponse["status"], type: PlayerTodayGameResponse["type"]): PlayerTodayGameResponse => ({
  show: false, status, isLive: false, opponentName: null, type,
});

export async function getPlayerTodayGameRouteResult(params: {
  teamId: number;
  name: string;
  pos?: string;
}) {
  const teamId = params.teamId;
  const name = params.name.trim();
  const pos = params.pos ?? "";
  const type: PlayerTodayGameResponse["type"] = pos.includes("투수") ? "pitcher" : "batter";

  if (!teamId || !name) {
    return { body: HIDDEN("none", type), headers: { "Cache-Control": "no-store" } };
  }

  try {
    const date = getKSTToday().replace(/-/g, "");
    const games = await fetchGames(date);
    // 더블헤더 대비: live 우선 → 없으면 오늘 final 우선 → 그 외 첫 경기
    const teamGames = games.filter((g) => g.awayTeamId === teamId || g.homeTeamId === teamId);
    const game = teamGames.find((g) => g.status === "live") ?? teamGames.find((g) => g.status === "final") ?? teamGames[0];

    if (!game) return NextResponse.json(HIDDEN("none", type), { headers: { "Cache-Control": "s-maxage=60" } });
    if (game.status === "scheduled" || game.status === "cancelled") {
      return NextResponse.json(HIDDEN(game.status, type), { headers: { "Cache-Control": "s-maxage=60" } });
    }

    // 라이브 박스스코어는 KBO 직접 호출이 비어 있어 game-detail(네이버 폴백 병합)을 재사용
    const detail = await getGameDetailRouteResult({ gameId: game.gameId }).catch(() => null);
    const box: DetailBox | null = detail?.boxScore ?? null;
    if (!box) return { body: HIDDEN(game.status, type), headers: { "Cache-Control": "s-maxage=20" } };

    const isHome = game.homeTeamId === teamId;
    const opponentName = getTeamById(isHome ? game.awayTeamId : game.homeTeamId)?.shortName ?? null;
    const isLive = game.status === "live";
    const ok = { "Cache-Control": "s-maxage=20, stale-while-revalidate=40" };

    if (type === "pitcher") {
      const row = (isHome ? box.homePitchers : box.awayPitchers).find((p) => p.name.trim() === name);
      if (!row) return { body: HIDDEN(game.status, type), headers: { "Cache-Control": "s-maxage=20" } };
      const pitcher: PitcherLine = {
        ip: row.inningsPitched, pitches: row.pitchCount, k: row.strikeouts, bb: row.walks,
        hits: row.hits, runs: row.runs, er: row.earnedRuns, decision: row.decision ?? "",
      };
      return { body: { show: true, status: game.status, isLive, opponentName, type, pitcher } satisfies PlayerTodayGameResponse, headers: ok };
    }

    const row = (isHome ? box.homeBatters : box.awayBatters).find((b) => b.name.trim() === name);
    if (!row) return { body: HIDDEN(game.status, type), headers: { "Cache-Control": "s-maxage=20" } };
    const batter: BatterLine = {
      ab: row.atBats, h: row.hits, hr: row.hr, rbi: row.rbi, runs: row.runs, bb: row.bb, sb: row.sb,
      onBase: row.hits + row.bb,
    };
    return { body: { show: true, status: game.status, isLive, opponentName, type, batter } satisfies PlayerTodayGameResponse, headers: ok };
  } catch {
    return { body: HIDDEN("none", type), status: 200, headers: { "Cache-Control": "no-store" } };
  }
}

export async function GET(req: NextRequest) {
  const result = await getPlayerTodayGameRouteResult({
    teamId: parseInt(req.nextUrl.searchParams.get("team") ?? "", 10),
    name: req.nextUrl.searchParams.get("name") ?? "",
    pos: req.nextUrl.searchParams.get("pos") ?? "",
  });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
