import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";

export interface RosterPlayer {
  name: string;
  kboId: string;
  teamId: number;
  position?: string;
  backNo?: string;
  team?: string;
}

interface ResolveRosterPlayerOptions {
  name: string | null | undefined;
  kboId?: string | null;
  teamId?: number | null;
  team?: string | null;
}

/**
 * Compatibility wrapper around the canonical player identity resolver.
 *
 * Older game/live components call `resolveRosterPlayer`; keep the API but make
 * the matching rules identical to `resolvePlayerIdentity` so foreign numeric
 * IDs, FP/AQ canonical IDs, short names, and full names all converge to one
 * roster player.
 */
export function resolveRosterPlayer({
  name,
  kboId,
  teamId,
  team,
}: ResolveRosterPlayerOptions): RosterPlayer | null {
  const resolved = resolvePlayerIdentity({ name, kboId, teamId, team });
  if (!resolved) return null;

  return {
    name: resolved.name,
    kboId: resolved.kboId,
    teamId: resolved.teamId,
    position: resolved.position,
    backNo: resolved.backNo,
    team: resolved.team,
  };
}
