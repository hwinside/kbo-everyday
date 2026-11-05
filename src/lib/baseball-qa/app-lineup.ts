import { fetchNaverLineup, type NaverLineupSnapshot } from "../crawler/naver-lineup";
import { fetchLineupConfirmed } from "../crawler/lineup-confirmed";
import { isCanonicalKboGameId } from "../game/game-id";
import type { ConversationGame } from "./game-conversation";

export interface AppLineupRequest { game: ConversationGame; date: string }
export interface AppLineupSnapshot {
  gameId: string;
  date: string;
  awayName: string;
  homeName: string;
  fetchedAt: number;
  source: "naver-preview";
  lineup: NaverLineupSnapshot;
}
export const APP_LINEUP_MAX_AGE_MS = 60_000;
export function isAppLineupRequest({ game, date }: AppLineupRequest): boolean {
  return !!game.gameId && isCanonicalKboGameId(game.gameId)
    && game.gameId.slice(0, 8) === date.replaceAll("-", "")
    && game.gameId.slice(12) === "0"
    && ["scheduled", "live", "final"].includes(game.status);
}

/** Only validated, requested games; no previous-game fallback or generated rows.
 * Reuse the app's confirmation policy (explicit KBO false wins) and Naver
 * complete-lineup parser, with additional response identity binding. */
export async function loadAppLineups(requests: AppLineupRequest[], deps = {
  fetchLineup: fetchNaverLineup, fetchConfirmed: fetchLineupConfirmed, now: Date.now,
}): Promise<Record<string, AppLineupSnapshot>> {
  const unique = [...new Map(requests.filter(isAppLineupRequest).map((r) => [r.game.gameId!, r])).values()];
  if (unique.length > 10) return {};
  const rows = await Promise.all(unique.map(async ({ game, date }) => {
    const gameId = game.gameId!;
    const [confirmed, lineup] = await Promise.all([
      deps.fetchConfirmed(gameId, { timeoutMs: 1200 }).catch(() => null),
      deps.fetchLineup(gameId, { timeoutMs: 1200, requireGameIdentity: true }).catch(() => null),
    ]);
    if (confirmed !== true || !lineup) return null;
    return { gameId, date, awayName: game.awayName, homeName: game.homeName,
      fetchedAt: deps.now(), source: "naver-preview" as const, lineup };
  }));
  return Object.fromEntries(rows.filter((r): r is AppLineupSnapshot => !!r).map((r) => [r.gameId, r]));
}

export function renderAppLineup(snapshot: AppLineupSnapshot | undefined, game: ConversationGame,
  date: string, now: number | undefined, teams: string[]): string[] | null {
  if (!snapshot || !isAppLineupRequest({ game, date }) || snapshot.gameId !== game.gameId
    || snapshot.date !== date || snapshot.awayName !== game.awayName || snapshot.homeName !== game.homeName
    || snapshot.source !== "naver-preview" || snapshot.lineup?.confirmed !== true
    || now === undefined || !Number.isFinite(snapshot.fetchedAt)
    || snapshot.fetchedAt > now || now - snapshot.fetchedAt > APP_LINEUP_MAX_AGE_MS) return null;
  const sides = [[game.awayName, snapshot.lineup.away], [game.homeName, snapshot.lineup.home]] as const;
  // Reject the whole snapshot if either side is incomplete or malformed.
  if (sides.some(([, side]) => !side || typeof side.starter !== "string" || !side.starter.trim()
    || !Array.isArray(side.batters) || side.batters.length !== 9
    || side.batters.some((b, i) => b.order !== i + 1 || typeof b.name !== "string" || !b.name.trim()))) return null;
  return sides.filter(([team]) => !teams.length || teams.includes(team)).map(([team, side]) =>
    `  ${team} 선발 타순: ${side.batters.map((b) => `${b.order}번 ${b.name}`).join(" · ")}`);
}
