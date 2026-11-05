import type { KboGame } from "@/lib/crawler/kbo-api";
import { buildPostseasonLadder, type Seed } from "@/lib/postseason/ladder";

/** Rebuild at this game's cutoff; later results must never rewrite an earlier recap. */
export function summaryPostseasonFacts(game: KboGame, games: KboGame[], seeds: Seed[]): string | null {
  const rows = games.filter(g => g.srId === game.srId && g.gameId <= game.gameId && g.gameId !== game.gameId);
  rows.push(game);
  const round = buildPostseasonLadder(Number(game.gameId.slice(0, 4)), rows, seeds, 0).rounds.find(r => r.id === game.srId);
  if (!round || round.participants.length !== 2) return null;
  const completed = round.games.filter(g => g.status === "final");
  const number = Number(game.gameLabel?.match(/(\d+)\s*$/)?.[1]);
  // If the official game number exposes a missing result, do not assert cumulative facts.
  if (!Number.isInteger(number) || number < 1 || number !== completed.length) return null;
  const actual = round.participants.map(p => `${p.name} ${p.wins}승`).join(" · ");
  const wins = round.participants.find(p => p.teamId === round.winnerId);
  const loser = round.participants.find(p => p.teamId !== round.winnerId);
  const next = ({ "4": "준PO", "3": "PO", "5": "한국시리즈" } as Record<string, string>)[round.id];
  const result = wins && loser
    ? `${wins.name} ${next ? `${next} 진출 확정` : "한국시리즈 우승 확정"}, ${loser.name} 시즌 종료.`
    : "진출·탈락 결과 미확정.";
  return `${round.label}: 실제 경기 전적 ${actual} · ${round.draws}무 (어드밴티지 미포함). ${result}`;
}

export async function loadSummaryPostseasonFacts(game: KboGame): Promise<string | null> {
  const [{ fetchNaverGames }, { loadPostseasonSeeds }, { REGULAR_SEASON_WINDOWS }] = await Promise.all([
    import("@/lib/crawler/naver-games"), import("@/lib/postseason/seeds"), import("@/lib/constants/season"),
  ]);
  const season = game.gameId.slice(0, 4);
  const window = REGULAR_SEASON_WINDOWS[season];
  if (!window?.finalized) return null;
  const [games, seeds] = await Promise.all([
    fetchNaverGames(window.end, undefined, { toDate: game.gameId.slice(0, 8), timeoutMs: 3000 }),
    loadPostseasonSeeds(Number(season)),
  ]);
  return summaryPostseasonFacts(game, games, seeds);
}
