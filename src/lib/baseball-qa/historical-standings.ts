import { getTeamById } from "@/lib/constants/teams";
import { resolveTeamId } from "@/lib/crawler/kbo-api";
import type { GameConversationInput } from "./game-conversation";

export interface HistoricalStandings {
  season: number;
  competition: "REGULAR_SEASON";
  sourceUrl: string;
  fetchedAt: number;
  rows: { teamName: string; displayName: string; teamId: number; ranking: number; wins: number; losses: number; draws: number }[];
}

export const historicalStandingsUrl = (season: number) =>
  `https://api-gw.sports.naver.com/statistics/categories/kbo/seasons/${season}/teams?gameType=REGULAR_SEASON`;

/** Explicit season is quoted to the user, not inferred from the retrieved
 * document. Relative season references require year clarification. */
export function requestedHistoricalSeason(req: Record<string, unknown>, input: GameConversationInput): number | null {
  const s = req.seasonRequest as Record<string, unknown> | undefined;
  if (!s) return null;
  const text = s.source === "question" ? input.question
    : s.source === "context_question" ? input.context?.question : undefined;
  if (!text || typeof s.quote !== "string" || !s.quote.trim() || !text.includes(s.quote)) return null;
  const current = Number(input.date.slice(0, 4));
  let season: number;
  if (s.basis === "year" && Number.isInteger(s.year) && s.quote.includes(String(s.year))) season = Number(s.year);
  else return null;
  // Ten-team, 144-game format only. Older formats need their own data contract.
  return season >= 2015 && season < current ? season : null;
}

/** No current-year HTML fallback. Request URL, season and competition travel
 * together. A partial/exhibition table cannot become a completed regular season. */
export function parseHistoricalStandings(body: unknown, season: number, fetchedAt: number): HistoricalStandings | null {
  if (!Number.isInteger(season) || season < 2015 || !Number.isFinite(fetchedAt)) return null;
  const data = body as { success?: boolean; result?: { seasonTeamStats?: Record<string, unknown>[]; season?: unknown; seasonId?: unknown; gameType?: unknown } } | null;
  for (const meta of [data, data?.result] as (Record<string, unknown> | null | undefined)[]) {
    if (meta && ((meta.season !== undefined && String(meta.season) !== String(season))
      || (meta.seasonId !== undefined && String(meta.seasonId) !== String(season))
      || (meta.gameType !== undefined && meta.gameType !== "REGULAR_SEASON"))) return null;
  }
  const raw = data?.success === true ? data.result?.seasonTeamStats : null;
  if (!Array.isArray(raw) || raw.length !== 10) return null;
  const rows: HistoricalStandings["rows"] = [];
  for (const r of raw) {
    if (!r || typeof r.teamId !== "string" || typeof r.teamName !== "string" || !r.teamName.trim() || r.gameCount !== 144
      || ![r.ranking, r.winGameCount, r.loseGameCount, r.drawnGameCount].every(Number.isInteger)
      || Number(r.ranking) < 1 || Number(r.ranking) > 10
      || [r.winGameCount, r.loseGameCount, r.drawnGameCount].some(n => Number(n) < 0)
      || Number(r.winGameCount) + Number(r.loseGameCount) + Number(r.drawnGameCount) !== 144) return null;
    // Reject contradictory provider metadata when present; never overwrite it.
    if ((r.season !== undefined && String(r.season) !== String(season))
      || (r.seasonId !== undefined && String(r.seasonId) !== String(season))
      || (r.gameType !== undefined && r.gameType !== "REGULAR_SEASON")) return null;
    const teamId = resolveTeamId(r.teamId, "");
    const teamName = getTeamById(teamId)?.shortName;
    if (!teamName) return null;
    // Current canonical names bind user entities; provider names preserve the
    // historical club name (e.g. SK), not a retroactive rename to SSG.
    rows.push({ teamName, displayName: r.teamName, teamId, ranking: Number(r.ranking), wins: Number(r.winGameCount),
      losses: Number(r.loseGameCount), draws: Number(r.drawnGameCount) });
  }
  if (new Set(rows.map(r => r.teamId)).size !== 10
    || rows.reduce((n,r) => n + r.wins - r.losses, 0) !== 0
    || rows.reduce((n,r) => n + r.draws, 0) % 2 !== 0) return null;
  // REGULAR_SEASON selects the record totals, but the provider's ranking can
  // still mean postseason finishing order. Validate against exact W/(W+L),
  // never rounded wra. Equal rates need an independent tie-break source; we
  // cannot establish the final order from these totals and must hold.
  const byRate = [...rows].sort((a, b) => b.wins * (a.wins + a.losses) - a.wins * (b.wins + b.losses));
  for (let i = 0; i < byRate.length; i++) {
    const row = byRate[i], previous = byRate[i - 1];
    if (row.wins + row.losses === 0 || row.ranking !== i + 1) return null;
    if (previous && previous.wins * (row.wins + row.losses) === row.wins * (previous.wins + previous.losses)) return null;
  }
  return { season, competition: "REGULAR_SEASON", sourceUrl: historicalStandingsUrl(season), fetchedAt,
    rows: byRate };
}

export async function loadHistoricalStandings(season: number): Promise<HistoricalStandings | null> {
  const current = Number(new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0,4));
  if (!Number.isInteger(season) || season < 2015 || season >= current) return null;
  try {
    const response = await fetch(historicalStandingsUrl(season), {
      headers: { Referer: "https://sports.news.naver.com/" },
      signal: AbortSignal.timeout(2500), cache: "no-store", redirect: "error",
    });
    if (!response.ok) return null;
    return parseHistoricalStandings(await response.json(), season, Date.now());
  } catch { return null; }
}
