import pitcherStatsJson from "@/lib/constants/stats-2026-pitchers.json";
import { resolveRosterPlayer } from "@/lib/utils/player-roster";
import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";

type PitcherSeasonRow = {
  era?: string;
  kboId?: string;
  playerId?: string;
};

export function normalizePitcherEra(value?: string | null): string | null {
  const era = value?.trim();
  return era && Number.isFinite(Number(era)) ? era : null;
}

export function lookupPitcherSeasonEra(kboId?: string): string | null {
  if (!kboId) return null;
  const numericId = resolvePlayerIdentity(kboId)?.numericId ?? kboId;
  const row = (pitcherStatsJson as PitcherSeasonRow[]).find(
    (pitcher) =>
      String(pitcher.kboId) === kboId ||
      String(pitcher.playerId) === kboId ||
      String(pitcher.kboId) === numericId ||
      String(pitcher.playerId) === numericId,
  );
  return normalizePitcherEra(row?.era);
}

export function resolveStarterPitcher(
  name: string,
  teamId: number,
  boxEra?: string | null,
): { name: string; era: string; kboId?: string } {
  const roster = name ? resolveRosterPlayer({ name, teamId }) : null;
  return {
    name,
    era:
      normalizePitcherEra(boxEra)
      ?? lookupPitcherSeasonEra(roster?.kboId)
      ?? "-",
    kboId: roster?.kboId,
  };
}
