import { fetchGames } from "@/lib/crawler/kbo-api";
import { getKSTToday } from "@/lib/utils/date-kst";
import { getTeamById } from "@/lib/constants/teams";
import { getGameDetailRouteResult } from "@/lib/services/game-detail";

interface BatterLine {
  ab: number;
  h: number;
  hr: number;
  rbi: number;
  runs: number;
  bb: number;
  sb: number;
  onBase: number;
}

interface PitcherLine {
  ip: string;
  pitches: number;
  k: number;
  bb: number;
  hits: number;
  runs: number;
  er: number;
  decision: string;
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

interface DetailBatter {
  name: string;
  atBats: number;
  hits: number;
  hr: number;
  rbi: number;
  runs: number;
  bb: number;
  sb: number;
}

interface DetailPitcher {
  name: string;
  inningsPitched: string;
  pitchCount: number;
  strikeouts: number;
  walks: number;
  hits: number;
  runs: number;
  earnedRuns: number;
  decision: string;
}

interface DetailBox {
  awayBatters: DetailBatter[];
  homeBatters: DetailBatter[];
  awayPitchers: DetailPitcher[];
  homePitchers: DetailPitcher[];
}

type PlayerTodayGameResult = {
  body: PlayerTodayGameResponse;
  status?: number;
  headers?: HeadersInit;
};

const HIDDEN = (
  status: PlayerTodayGameResponse["status"],
  type: PlayerTodayGameResponse["type"],
): PlayerTodayGameResponse => ({
  show: false,
  status,
  isLive: false,
  opponentName: null,
  type,
});

function result(
  body: PlayerTodayGameResponse,
  headers: HeadersInit,
  status?: number,
): PlayerTodayGameResult {
  return { body, status, headers };
}

export async function getPlayerTodayGameRouteResult(params: {
  teamId: number;
  name: string;
  pos?: string;
}): Promise<PlayerTodayGameResult> {
  const teamId = params.teamId;
  const name = params.name.trim();
  const pos = params.pos ?? "";
  const type: PlayerTodayGameResponse["type"] = pos.includes("투수") ? "pitcher" : "batter";

  if (!teamId || !name) {
    return result(HIDDEN("none", type), { "Cache-Control": "no-store" });
  }

  try {
    const date = getKSTToday().replace(/-/g, "");
    const games = await fetchGames(date);
    const teamGames = games.filter((g) => g.awayTeamId === teamId || g.homeTeamId === teamId);
    const game =
      teamGames.find((g) => g.status === "live") ??
      teamGames.find((g) => g.status === "final") ??
      teamGames[0];

    if (!game) return result(HIDDEN("none", type), { "Cache-Control": "s-maxage=60" });
    if (game.status === "scheduled" || game.status === "cancelled") {
      return result(HIDDEN(game.status, type), { "Cache-Control": "s-maxage=60" });
    }

    const detail = await getGameDetailRouteResult({ gameId: game.gameId }).catch(() => null);
    const box: DetailBox | null = detail?.boxScore ?? null;
    if (!box) return result(HIDDEN(game.status, type), { "Cache-Control": "s-maxage=20" });

    const isHome = game.homeTeamId === teamId;
    const opponentName = getTeamById(isHome ? game.awayTeamId : game.homeTeamId)?.shortName ?? null;
    const isLive = game.status === "live";
    const okHeaders = { "Cache-Control": "s-maxage=20, stale-while-revalidate=40" };

    if (type === "pitcher") {
      const row = (isHome ? box.homePitchers : box.awayPitchers).find((p) => p.name.trim() === name);
      if (!row) return result(HIDDEN(game.status, type), { "Cache-Control": "s-maxage=20" });
      return result(
        {
          show: true,
          status: game.status,
          isLive,
          opponentName,
          type,
          pitcher: {
            ip: row.inningsPitched,
            pitches: row.pitchCount,
            k: row.strikeouts,
            bb: row.walks,
            hits: row.hits,
            runs: row.runs,
            er: row.earnedRuns,
            decision: row.decision ?? "",
          },
        },
        okHeaders,
      );
    }

    const row = (isHome ? box.homeBatters : box.awayBatters).find((b) => b.name.trim() === name);
    if (!row) return result(HIDDEN(game.status, type), { "Cache-Control": "s-maxage=20" });
    return result(
      {
        show: true,
        status: game.status,
        isLive,
        opponentName,
        type,
        batter: {
          ab: row.atBats,
          h: row.hits,
          hr: row.hr,
          rbi: row.rbi,
          runs: row.runs,
          bb: row.bb,
          sb: row.sb,
          onBase: row.hits + row.bb,
        },
      },
      okHeaders,
    );
  } catch {
    return result(HIDDEN("none", type), { "Cache-Control": "no-store" }, 200);
  }
}
