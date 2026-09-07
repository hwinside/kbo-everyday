import type { GameDetailResponse } from "@/lib/services/game-detail";
import { isCanonicalKboGameId } from "@/lib/game/game-id";
import type { ReviewContext } from "./domain";

// KBO canonical codes (not Naver display names; SK/HT/WO remain canonical).
const teamIds: Record<string, number> = { LG: 1, OB: 2, KT: 3, SK: 4, NC: 5, HT: 6, LT: 7, SS: 8, HH: 9, WO: 10 };
export function gameTeams(gameId: string): [number, number] {
  const away = teamIds[gameId.slice(8, 10)], home = teamIds[gameId.slice(10, 12)];
  if (!isCanonicalKboGameId(gameId) || !away || !home || away === home) throw new Error("올바른 경기 정보가 필요해요");
  return [away, home];
}
export function reviewContext(gameId: string, detail: GameDetailResponse): ReviewContext {
  const [awayTeamId, homeTeamId] = gameTeams(gameId);
  const score = detail.linescore;
  const winnerTeamId = !score || score.away.R === score.home.R ? null : score.away.R > score.home.R ? awayTeamId : homeTeamId;
  const box = detail.boxScore;
  const side = winnerTeamId === awayTeamId ? "away" : "home";
  // The source exposes participant names, not canonical player IDs. Store a verified
  // game-local participant key + name snapshot; never accept arbitrary client names.
  const players = box && winnerTeamId ? [
    ...box[`${side}Batters`].filter(p => p.name.trim()).map(p => ({ key: `b:${p.order}:${p.name.trim()}`, name: p.name.trim(), label: `${p.name.trim()} · ${p.order}번 타순` })),
    ...box[`${side}Pitchers`].filter(p => p.name.trim()).map(p => ({ key: `p:${p.name.trim()}`, name: p.name.trim(), label: `${p.name.trim()} · 투수` })),
  ] : [];
  return { gameId, awayTeamId, homeTeamId, winnerTeamId, final: detail.status === "final",
    players: [...new Map(players.map(p => [p.key, p])).values()],
    score: score ? `${score.away.R} : ${score.home.R}` : "종료" };
}
