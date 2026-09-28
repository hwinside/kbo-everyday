import type { CelebrationEventType } from "@/components/game/CelebrationOverlay";
import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";
import type { RosterPlayer } from "@/types/api";

/** Names and teams are not unique: bind celebration photos to the event role. */
export function resolveCelebrationPlayerId(
  name: string | undefined,
  teamId: number,
  type: CelebrationEventType,
  roster?: RosterPlayer[],
): string | undefined {
  if (!name || type === "victory") return undefined;
  const positionHint = type === "strikeout" ? "투수" : "야수";
  const player = resolvePlayerIdentity({ name, teamId, positionHint }, roster);
  // The general resolver has cross-team fallbacks; event photos must not.
  if (!player || player.teamId !== teamId) return undefined;
  if ((player.position === "투수") !== (positionHint === "투수")) return undefined;
  return player.kboId;
}
