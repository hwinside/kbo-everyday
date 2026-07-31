import pitcherStatsJson from "@/lib/constants/stats-2026-pitchers.json";
import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";

type PitcherSeasonRow = {
  era?: string;
  kboId?: string;
  playerId?: string;
};

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
  const era = row?.era?.trim();
  return era && Number.isFinite(Number(era)) ? era : null;
}
