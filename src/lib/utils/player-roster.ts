import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { getTeamById, TEAMS } from "@/lib/constants/teams";

const KBO_TO_TEAM_ID = new Map<string, number>(
  (PLAYERS_ROSTER as { kboId: string; teamId: number }[]).map((p) => [p.kboId, p.teamId]),
);

const KBO_TO_NAME = new Map<string, string>(
  (PLAYERS_ROSTER as { kboId: string; name: string }[]).map((p) => [String(p.kboId), p.name]),
);

const SLUG_TO_TEAM_ID = new Map<string, number>(TEAMS.map((t) => [t.slug, t.id]));

/**
 * 팀 슬러그 → 그 팀 소속 선수들의 kboId 목록.
 *
 * V3 팀 피드는 team_tags(contains)만으로 조회하는데, 레거시·움짤콜렉터 글은
 * board_type='player' + board_id=kboId 만 있고 team_tags 가 비어 팀탭에서 누락된다.
 * 팀 피드 쿼리에서 이 kboId 목록으로 board_id.in 매칭을 OR 로 더해 선수보드 글까지 포착한다.
 */
export function kboIdsForTeamSlug(slug: string): string[] {
  const teamId = SLUG_TO_TEAM_ID.get(slug);
  if (teamId == null) return [];
  return (PLAYERS_ROSTER as { kboId: string; teamId: number }[])
    .filter((p) => p.teamId === teamId)
    .map((p) => String(p.kboId));
}

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

/** 선수 kboId → 소속팀 id (로스터 기준). 미등록이면 null. */
export function teamIdForKboId(kboId: string): number | null {
  return KBO_TO_TEAM_ID.get(String(kboId)) ?? null;
}

/** 선수 kboId → 표시 이름 (로스터 기준). 미등록이면 null. */
export function playerNameForKboId(kboId: string): string | null {
  return KBO_TO_NAME.get(String(kboId)) ?? null;
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
  /** 같은 팀 동명이인 분리용 역할 힌트 — resolvePlayerIdentity 로 그대로 전달. */
  positionHint?: "투수" | "야수" | null;
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
  positionHint,
}: ResolveRosterPlayerOptions): RosterPlayer | null {
  const resolved = resolvePlayerIdentity({ name, kboId, teamId, team, positionHint });
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
