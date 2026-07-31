import type { InterviewMatchContext } from "./postgame-interviews";
import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";

interface ScheduledGame {
  gameId: string;
  date: string;
  awayTeamId: number;
  homeTeamId: number;
}

interface StoredInterviewJob {
  game_id: string;
  game_date: string;
  winner_team_id: number;
  is_doubleheader: boolean;
  ended_at: string;
  expires_at: string;
}

export interface InterviewPlayerLink {
  name: string;
  kboId: string | null;
  teamId: number;
}

export function interviewPlayerLinks(
  playerNames: string[],
  winnerTeamId: number | null | undefined,
): InterviewPlayerLink[] {
  const uniqueNames = [...new Set(playerNames.map((name) => name.trim()).filter(Boolean))];
  return uniqueNames.map((name) => {
    const resolved = winnerTeamId == null
      ? null
      : resolvePlayerIdentity({ name, teamId: winnerTeamId });
    return {
      name,
      kboId: resolved?.kboId ?? null,
      teamId: resolved?.teamId ?? winnerTeamId ?? 0,
    };
  });
}

export function doubleheaderGameIds(games: ScheduledGame[]): Set<string> {
  const matchupGames = new Map<string, string[]>();
  for (const game of games) {
    const gameDate = /^(\d{4})(\d{2})(\d{2})$/.test(game.date)
      ? `${game.date.slice(0, 4)}-${game.date.slice(4, 6)}-${game.date.slice(6, 8)}`
      : game.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) continue;
    const teams = [game.awayTeamId, game.homeTeamId].sort((a, b) => a - b);
    const key = `${gameDate}:${teams[0]}:${teams[1]}`;
    matchupGames.set(key, [...(matchupGames.get(key) ?? []), game.gameId]);
  }

  return new Set(
    [...matchupGames.values()]
      .filter((gameIds) => gameIds.length > 1)
      .flat(),
  );
}

export function contextFromStoredJob(
  job: StoredInterviewJob,
  winnerPlayerNames: string[],
): InterviewMatchContext {
  return {
    gameId: job.game_id,
    gameDate: job.game_date,
    winnerTeamId: job.winner_team_id,
    winnerPlayerNames,
    isDoubleheader: job.is_doubleheader,
    endedAt: job.ended_at,
    expiresAt: job.expires_at,
  };
}
