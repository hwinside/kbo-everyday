import { TEAMS } from "@/lib/constants/teams";
import type { TeamSeasonTotals } from "@/lib/venue-stats/aggregate";

export const CURRENT_SEASON_BASELINE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface BatterSeasonBaseline {
  ab: number;
  h: number;
  hr: number;
  rbi: number;
  games: number;
}

export interface PitcherSeasonBaseline {
  outs: number;
  er: number;
  k: number;
  games: number;
}

export interface FavoriteSeasonBaselineSnapshot {
  batter: BatterSeasonBaseline | null;
  pitcher: PitcherSeasonBaseline | null;
}

interface BundledBatterRow {
  kboId?: unknown;
  playerId?: unknown;
  team?: unknown;
  games?: unknown;
  ab?: unknown;
  hits?: unknown;
  hr?: unknown;
  rbi?: unknown;
}

interface BundledPitcherRow {
  kboId?: unknown;
  playerId?: unknown;
  team?: unknown;
  games?: unknown;
  ip?: unknown;
  h?: unknown;
  er?: unknown;
  so?: unknown;
}

interface LiveBatterRow {
  kbo_id?: unknown;
  team?: unknown;
  games?: unknown;
  ab?: unknown;
  hits?: unknown;
  hr?: unknown;
  rbi?: unknown;
  updated_at?: unknown;
}

interface LivePitcherRow {
  kbo_id?: unknown;
  team?: unknown;
  games?: unknown;
  ip?: unknown;
  h?: unknown;
  er?: unknown;
  so?: unknown;
  updated_at?: unknown;
}

export interface CurrentSeasonBaselineInput {
  season: number;
  currentSeason: number;
  generatedAt: string;
  nowMs?: number;
  teamRecords: {
    season: number;
    batting: Array<{
      teamId: number;
      slug: string;
      avg: string;
      hr: number;
      games?: number;
      ab?: number;
      hits?: number;
    }>;
    pitching: Array<{
      teamId: number;
      slug: string;
      era: string;
      games?: number;
      inningsOuts?: number;
      er?: number;
      hitsAllowed?: number;
    }>;
  } | null;
  favoriteIds: string[];
  bundledBatters: readonly BundledBatterRow[];
  bundledPitchers: readonly BundledPitcherRow[];
  liveBatters: readonly LiveBatterRow[];
  livePitchers: readonly LivePitcherRow[];
}

export interface CurrentSeasonBaselines {
  teamSeasonTotals: Map<number, TeamSeasonTotals> | null;
  favoriteSeasonBaselines: Map<string, FavoriteSeasonBaselineSnapshot> | null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseSeasonInningsOuts(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 3;
  const fraction = raw.match(/^(?:(\d+)\s+)?([012])\/3$/);
  if (!fraction) return null;
  return Number(fraction[1] ?? 0) * 3 + Number(fraction[2]);
}

function isFresh(timestamp: unknown, nowMs: number): boolean {
  if (typeof timestamp !== "string") return false;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed <= nowMs && nowMs - parsed <= CURRENT_SEASON_BASELINE_MAX_AGE_MS;
}

function officialTeamSeasonTotals(
  records: CurrentSeasonBaselineInput["teamRecords"],
  season: number,
): Map<number, TeamSeasonTotals> | null {
  if (
    records === null ||
    records.season !== season ||
    records.batting.length !== TEAMS.length ||
    records.pitching.length !== TEAMS.length
  ) return null;

  const battingByTeam = new Map(records.batting.map((row) => [row.teamId, row]));
  const pitchingByTeam = new Map(records.pitching.map((row) => [row.teamId, row]));
  const totals = new Map<number, TeamSeasonTotals>();
  for (const team of TEAMS) {
    const batting = battingByTeam.get(team.id);
    const pitching = pitchingByTeam.get(team.id);
    if (!batting || !pitching || batting.slug !== team.slug || pitching.slug !== team.slug) return null;

    const games = nonNegativeInteger(batting.games);
    const pitchingGames = nonNegativeInteger(pitching.games);
    const ab = nonNegativeInteger(batting.ab);
    const h = nonNegativeInteger(batting.hits);
    const hr = nonNegativeInteger(batting.hr);
    const outs = nonNegativeInteger(pitching.inningsOuts);
    const er = nonNegativeInteger(pitching.er);
    const hAllowed = nonNegativeInteger(pitching.hitsAllowed);
    const publishedAvg = Number(batting.avg);
    const publishedEra = Number(pitching.era);
    if (
      games === null || games <= 0 || pitchingGames !== games ||
      ab === null || ab <= 0 || h === null || h > ab || hr === null ||
      outs === null || outs <= 0 || er === null || hAllowed === null ||
      !Number.isFinite(publishedAvg) || Math.abs(h / ab - publishedAvg) > 0.0005 ||
      !Number.isFinite(publishedEra) || Math.abs((27 * er) / outs - publishedEra) > 0.005
    ) return null;

    totals.set(team.id, {
      teamId: team.id,
      completeGames: games,
      ab,
      h,
      hr,
      outs,
      er,
      hAllowed,
    });
  }
  return totals.size === TEAMS.length ? totals : null;
}

function playerId(row: { kboId?: unknown; playerId?: unknown }): string | null {
  const value = row.kboId ?? row.playerId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bundledBatter(row: BundledBatterRow): (BatterSeasonBaseline & { team: string }) | null {
  const team = typeof row.team === "string" ? row.team : null;
  const games = nonNegativeInteger(row.games);
  const ab = nonNegativeInteger(row.ab);
  const h = nonNegativeInteger(row.hits);
  const hr = nonNegativeInteger(row.hr);
  const rbi = nonNegativeInteger(row.rbi);
  if (!team || games === null || ab === null || h === null || hr === null || rbi === null) return null;
  return { team, games, ab, h, hr, rbi };
}

function bundledPitcher(row: BundledPitcherRow): (PitcherSeasonBaseline & { team: string; hAllowed: number }) | null {
  const team = typeof row.team === "string" ? row.team : null;
  const games = nonNegativeInteger(row.games);
  const outs = parseSeasonInningsOuts(row.ip);
  const hAllowed = nonNegativeInteger(row.h);
  const er = nonNegativeInteger(row.er);
  const k = nonNegativeInteger(row.so);
  if (!team || games === null || outs === null || hAllowed === null || er === null || k === null) return null;
  return { team, games, outs, hAllowed, er, k };
}

/**
 * 팀 비교값은 공식 팀기록 raw totals, 최애 비교값은 기존 선수 시즌 스냅샷을 사용한다.
 * 선수 번들을 완전한 기준 집합으로 두고 같은 kbo_id의 신선한 DB 행만 덮어쓴다.
 * 두 소스는 독립적으로 fail-close하며 이름 매칭·선수 누적합의 팀 환산은 하지 않는다.
 */
export function buildCurrentSeasonBaselines(input: CurrentSeasonBaselineInput): CurrentSeasonBaselines | null {
  if (input.season !== input.currentSeason) return null;
  const nowMs = input.nowMs ?? Date.now();
  const teamSeasonTotals = officialTeamSeasonTotals(input.teamRecords, input.season);
  if (!isFresh(input.generatedAt, nowMs)) {
    return { teamSeasonTotals, favoriteSeasonBaselines: null };
  }

  const batters = new Map<string, BatterSeasonBaseline & { team: string }>();
  for (const row of input.bundledBatters) {
    const id = playerId(row);
    const parsed = bundledBatter(row);
    if (!id || !parsed || batters.has(id)) {
      return { teamSeasonTotals, favoriteSeasonBaselines: null };
    }
    batters.set(id, parsed);
  }
  const pitchers = new Map<string, PitcherSeasonBaseline & { team: string; hAllowed: number }>();
  for (const row of input.bundledPitchers) {
    const id = playerId(row);
    const parsed = bundledPitcher(row);
    if (!id || !parsed || pitchers.has(id)) {
      return { teamSeasonTotals, favoriteSeasonBaselines: null };
    }
    pitchers.set(id, parsed);
  }

  for (const row of input.liveBatters) {
    const id = typeof row.kbo_id === "string" ? row.kbo_id : null;
    if (!id || !batters.has(id) || !isFresh(row.updated_at, nowMs)) continue;
    const parsed = bundledBatter({
      team: row.team,
      games: row.games,
      ab: row.ab,
      hits: row.hits,
      hr: row.hr,
      rbi: row.rbi,
    });
    if (parsed) batters.set(id, parsed);
  }
  for (const row of input.livePitchers) {
    const id = typeof row.kbo_id === "string" ? row.kbo_id : null;
    if (!id || !pitchers.has(id) || !isFresh(row.updated_at, nowMs)) continue;
    const parsed = bundledPitcher({
      team: row.team,
      games: row.games,
      ip: row.ip,
      h: row.h,
      er: row.er,
      so: row.so,
    });
    if (parsed) pitchers.set(id, parsed);
  }

  const favoriteSeasonBaselines = new Map<string, FavoriteSeasonBaselineSnapshot>();
  for (const id of new Set(input.favoriteIds)) {
    const batter = batters.get(id) ?? null;
    const pitcher = pitchers.get(id) ?? null;
    favoriteSeasonBaselines.set(id, {
      batter: batter && batter.ab > 0
        ? { ab: batter.ab, h: batter.h, hr: batter.hr, rbi: batter.rbi, games: batter.games }
        : null,
      pitcher: pitcher && pitcher.outs > 0
        ? { outs: pitcher.outs, er: pitcher.er, k: pitcher.k, games: pitcher.games }
        : null,
    });
  }
  return { teamSeasonTotals, favoriteSeasonBaselines };
}
