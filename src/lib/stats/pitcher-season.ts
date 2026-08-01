import pitcherStatsJson from "@/lib/constants/stats-2026-pitchers.json";
import { resolveRosterPlayer } from "@/lib/utils/player-roster";
import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";
import type { LineupSource } from "@/lib/source-snapshot";

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
  boxPitcherName?: string | null,
): { name: string; era: string; kboId?: string } {
  const roster = name ? resolveRosterPlayer({ name, teamId }) : null;
  const starterKboId = roster?.kboId;
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

export function resolveLineupStarter({
  liveStarterName,
  lineupStarterName,
  liveStarterFresh,
  lineupStarterTrusted,
  lineupSource,
  teamId,
  boxPitcher,
}: {
  liveStarterName?: string | null;
  lineupStarterName?: string | null;
  liveStarterFresh: boolean;
  lineupStarterTrusted: boolean;
  lineupSource?: LineupSource | null;
  teamId: number;
  boxPitcher?: { name?: string | null; era?: string | null } | null;
}): { name: string; era: string; kboId?: string } {
  const liveName = liveStarterName?.trim() || "";
  const lineupName = lineupStarterName?.trim() || "";
  const boxName = boxPitcher?.name?.trim();
  const validBoxName = boxName && !/^선수\(\d+\)$/.test(boxName) ? boxName : "";
  // Live와 confirmed lineup이 다르면 요청 완료시각으로 신구를 추측하지 않는다.
  // 비교 가능한 upstream revision이 없으므로 identity-bound confirmed lineup을 우선한다.
  const lineupConfirmed = lineupSource == null
    ? lineupStarterTrusted
    : lineupSource === "kbo-confirmed" || lineupSource === "naver-confirmed";
  const confirmedMismatch = Boolean(
    lineupConfirmed && lineupStarterTrusted && lineupName && liveName && lineupName !== liveName,
  );
  const starterName = confirmedMismatch
    ? lineupName
    : liveStarterFresh && liveName
      ? liveName
      : lineupStarterTrusted
        ? lineupName
        : "";
  return resolveStarterPitcher(starterName, teamId, boxPitcher?.era, validBoxName);
}
