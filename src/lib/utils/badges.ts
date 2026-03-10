import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { TEAMS as KBO_TEAMS } from "@/lib/constants/teams";
import { BADGE_MAP } from "@/lib/constants/badges";
import type { BadgeDefinition } from "@/lib/constants/badges";

export function parseDynamicBadge(badgeId: string): BadgeDefinition | null {
  const playerMatch = badgeId.match(/^fan-player:(.+):(\d+)$/);
  if (playerMatch) {
    const [, playerId, level] = playerMatch;
    const playerName = Object.entries(PLAYER_PHOTO_MAP).find(([, id]) => id === playerId)?.[0] || playerId;
    const lvl = parseInt(level);
    const rarity = lvl <= 2 ? "common" : lvl <= 3 ? "rare" : lvl <= 4 ? "epic" : "legendary";
    return { id: badgeId, name: `${playerName} 덕후 Lv.${level}`, icon: "⭐", description: `${playerName} 게시판 활동`, category: "fan", rarity };
  }
  const teamMatch = badgeId.match(/^fan-team:(\d+):(\d+)$/);
  if (teamMatch) {
    const [, teamId, level] = teamMatch;
    const teamName = KBO_TEAMS.find(t => String(t.id) === teamId)?.shortName || teamId;
    const lvl = parseInt(level);
    const rarity = lvl <= 2 ? "common" : lvl <= 3 ? "rare" : lvl <= 4 ? "epic" : "legendary";
    return { id: badgeId, name: `${teamName} 광팬 Lv.${level}`, icon: "🏟️", description: `${teamName} 게시판 활동`, category: "fan", rarity };
  }
  return null;
}

export function getBadgeInfo(badgeId: string): BadgeDefinition | null {
  return BADGE_MAP[badgeId] || parseDynamicBadge(badgeId);
}
