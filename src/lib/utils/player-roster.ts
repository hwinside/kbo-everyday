import playersRoster from "@/lib/constants/players-roster.json";
import { FOREIGN_NUMERIC_TO_ALPHA } from "@/lib/constants/foreign-id-map";

export interface RosterPlayer {
  name: string;
  kboId: string;
  teamId: number;
  position?: string;
  backNo?: string;
  team?: string;
}

const roster = playersRoster as RosterPlayer[];

interface ResolveRosterPlayerOptions {
  name: string | null | undefined;
  kboId?: string | null;
  teamId?: number | null;
  team?: string | null;
}

/**
 * Resolve a player without accidentally crossing 동명이인.
 *
 * Priority:
 * 1. exact kboId
 * 2. name + teamId
 * 3. name + team short/name string
 * 4. name-only only when it is globally unique
 *
 * If a name is ambiguous and no team/kboId is provided, return null instead of
 * attaching the wrong player's photo/link.
 */
export function resolveRosterPlayer({
  name,
  kboId,
  teamId,
  team,
}: ResolveRosterPlayerOptions): RosterPlayer | null {
  const cleanName = name?.trim();
  if (!cleanName) return null;

  if (kboId) {
    const normalizedId = String(kboId);
    const byId = roster.find((p) => String(p.kboId) === normalizedId);
    if (byId) return byId;

    const foreignCanonicalId = FOREIGN_NUMERIC_TO_ALPHA[normalizedId];
    if (foreignCanonicalId) {
      const byForeignAlias = roster.find((p) => String(p.kboId) === foreignCanonicalId);
      if (byForeignAlias) return byForeignAlias;
    }
  }

  if (teamId !== undefined && teamId !== null) {
    const byTeamId = roster.find(
      (p) => p.name === cleanName && Number(p.teamId) === Number(teamId),
    );
    if (byTeamId) return byTeamId;
  }

  if (team) {
    const byTeam = roster.find((p) => p.name === cleanName && p.team === team);
    if (byTeam) return byTeam;
  }

  const matches = roster.filter((p) => p.name === cleanName);
  return matches.length === 1 ? matches[0] : null;
}
