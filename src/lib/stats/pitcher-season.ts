import pitcherStatsJson from "@/lib/constants/stats-2026-pitchers.json";
import { TEAMS } from "@/lib/constants/teams";
import { resolveRosterPlayer } from "@/lib/utils/player-roster";
import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";

type PitcherSeasonRow = {
  era?: string;
  kboId?: string;
  playerId?: string;
  name?: string;
  team?: string;
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

function lookupPitcherSeasonIdentity(name: string, teamId: number): PitcherSeasonRow | null {
  const team = TEAMS.find((candidate) => candidate.id === teamId)?.shortName;
  if (!name || !team) return null;
  const matches = (pitcherStatsJson as PitcherSeasonRow[]).filter(
    (pitcher) => pitcher.name?.trim() === name.trim() && pitcher.team === team,
  );
  return matches.length === 1 ? matches[0] : null;
}

export function resolveStarterPitcher(
  name: string,
  teamId: number,
  boxEra?: string | null,
  boxPitcherName?: string | null,
): { name: string; era: string; kboId?: string } {
  const roster = name ? resolveRosterPlayer({ name, teamId }) : null;
  const seasonIdentity = roster ? null : lookupPitcherSeasonIdentity(name, teamId);
  const starterKboId = roster?.kboId
    ?? seasonIdentity?.kboId
    ?? seasonIdentity?.playerId;
  const boxRoster = boxPitcherName
    ? resolveRosterPlayer({ name: boxPitcherName, teamId })
    : null;
  const boxMatchesStarter = Boolean(
    boxPitcherName && (
      (roster?.kboId && boxRoster?.kboId === roster.kboId)
      || boxPitcherName.trim() === name.trim()
    ),
  );
  return {
    name,
    era:
      (boxMatchesStarter ? normalizePitcherEra(boxEra) : null)
      ?? lookupPitcherSeasonEra(starterKboId)
      ?? "-",
    kboId: starterKboId,
  };
}
