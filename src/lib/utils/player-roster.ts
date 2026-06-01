import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { getTeamById } from "@/lib/constants/teams";

const KBO_TO_TEAM_ID = new Map<string, number>(
  (PLAYERS_ROSTER as { kboId: string; teamId: number }[]).map((p) => [p.kboId, p.teamId]),
);

/**
 * player_tags("kboId:name") → 소속팀 슬러그 목록(dedupe).
 *
 * V3 팀 피드는 team_tags 단일 컬럼(contains)으로 조회한다. 따라서 선수 태그가 달린
 * 글이 그 선수의 팀 피드에도 노출되려면 team_tags 에 팀 슬러그가 union 되어 있어야 한다.
 * (scripts/migrations/backfill-player-team-tags.mjs 와 동일 매핑 — 신규 글은 createPost 에서 적용)
 */
export function teamSlugsForPlayerTags(playerTags: string[] | undefined | null): string[] {
  if (!Array.isArray(playerTags)) return [];
  const slugs = new Set<string>();
  for (const tag of playerTags) {
    const kboId = String(tag).split(":")[0];
    const teamId = KBO_TO_TEAM_ID.get(kboId);
    const slug = teamId != null ? getTeamById(teamId)?.slug : undefined;
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

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
