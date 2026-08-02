import { matchPlayers, type PlayerAlias } from "@/lib/video/player-tagger";
import type { PlayerTagChannel } from "@/lib/video/team-channels";

export interface StoredPlayerTagRow {
  title: string;
  channel_id: string | null;
  source_type: string | null;
  player_id: string | null;
  player_ids: string[];
  team_id: string | null;
}

export interface RevalidatedPlayerTags {
  allowed: boolean;
  playerId: string | null;
  playerIds: string[];
  teamId: string | null;
}

/**
 * 수집 계약을 legacy 저장행에 그대로 재적용한다.
 * channel/alias metadata가 없거나 requested favorite와 교집합이 사라지면 fail-close.
 */
export function revalidateStoredPlayerTags(
  row: StoredPlayerTagRow,
  players: PlayerAlias[],
  channel: PlayerTagChannel | null,
  requiredPlayerIds: ReadonlySet<string> | null = null,
): RevalidatedPlayerTags {
  const storedIds = Array.from(
    new Set([...row.player_ids, row.player_id].filter((id): id is string => Boolean(id))),
  );
  if (!String(row.source_type ?? "").startsWith("community_") || storedIds.length === 0) {
    return {
      allowed: true,
      playerId: row.player_id,
      playerIds: storedIds,
      teamId: row.team_id,
    };
  }
  if (!channel || !Number.isFinite(channel.tier)) {
    return { allowed: false, playerId: null, playerIds: [], teamId: null };
  }

  const matchedIds = new Set(matchPlayers(row.title, players, null, channel.tier));
  const validIds = storedIds.filter((id) => matchedIds.has(id));
  if (validIds.length === 0) {
    return { allowed: false, playerId: null, playerIds: [], teamId: null };
  }
  if (requiredPlayerIds && !validIds.some((id) => requiredPlayerIds.has(id))) {
    return { allowed: false, playerId: null, playerIds: [], teamId: null };
  }

  const firstPlayer = players.find((player) => player.kbo_id === validIds[0]);
  if (!firstPlayer) {
    return { allowed: false, playerId: null, playerIds: [], teamId: null };
  }
  return {
    allowed: true,
    playerId: validIds[0],
    playerIds: validIds,
    teamId: firstPlayer.team,
  };
}
