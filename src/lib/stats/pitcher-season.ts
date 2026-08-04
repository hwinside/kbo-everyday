import pitcherStatsJson from "@/lib/constants/stats-2026-pitchers.json";
import { resolveRosterPlayer } from "@/lib/utils/player-roster";
import { resolvePlayerIdentity } from "@/lib/utils/resolve-player";
import type { LineupSource } from "@/lib/source-snapshot";

export type PitcherSeasonRow = {
  era?: string;
  kboId?: string;
  playerId?: string;
};

/**
 * 선발 ERA 해석기가 의존하는 외부 데이터.
 *
 * 프로덕션 바인딩은 이 파일 하단에서 실제 stats/roster JSON으로 한 번만 만든다.
 * 주입 가능한 이유는 테스트 때문이다 — 이전에는 QA 스모크가 매일 크롤로 갱신되는
 * `stats-2026-pitchers.json`의 실제 방어율을 기대값으로 하드코딩해서, 선발이
 * 등판해 ERA가 바뀔 때마다 prebuild가 RED가 되고 자동 업데이트 PR이 머지되지
 * 못했다(2026-08-01~08-03 스탯 반영 정지). 로직 검증은 고정 fixture로,
 * 프로덕션 결선은 아래 기본 바인딩으로 분리한다.
 */
export interface PitcherSeasonDeps {
  /** 시즌 투수 기록 테이블. */
  pitcherRows: PitcherSeasonRow[];
  /** 이름+팀 → 로스터 선수(canonical kboId). */
  resolveRoster: (query: { name: string; teamId: number }) => { kboId: string } | null;
  /** canonical kboId → KBO 숫자 ID (외국인 역매핑). */
  toNumericId: (kboId: string) => string | undefined;
}

export function normalizePitcherEra(value?: string | null): string | null {
  const era = value?.trim();
  return era && Number.isFinite(Number(era)) ? era : null;
}

export function createPitcherSeasonResolver({
  pitcherRows,
  resolveRoster,
  toNumericId,
}: PitcherSeasonDeps) {
  function lookupPitcherSeasonEra(kboId?: string): string | null {
    if (!kboId) return null;
    const numericId = toNumericId(kboId) ?? kboId;
    const row = pitcherRows.find(
      (pitcher) =>
        String(pitcher.kboId) === kboId ||
        String(pitcher.playerId) === kboId ||
        String(pitcher.kboId) === numericId ||
        String(pitcher.playerId) === numericId,
    );
    return normalizePitcherEra(row?.era);
  }

  function resolveStarterPitcher(
    name: string,
    teamId: number,
    boxEra?: string | null,
    boxPitcherName?: string | null,
  ): { name: string; era: string; kboId?: string } {
    const roster = name ? resolveRoster({ name, teamId }) : null;
    const starterKboId = roster?.kboId;
    const boxRoster = boxPitcherName
      ? resolveRoster({ name: boxPitcherName, teamId })
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

  function resolveLineupStarter({
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

  return { lookupPitcherSeasonEra, resolveStarterPitcher, resolveLineupStarter };
}

const productionResolver = createPitcherSeasonResolver({
  pitcherRows: pitcherStatsJson as PitcherSeasonRow[],
  resolveRoster: ({ name, teamId }) => resolveRosterPlayer({ name, teamId }),
  toNumericId: (kboId) => resolvePlayerIdentity(kboId)?.numericId,
});

export const lookupPitcherSeasonEra = productionResolver.lookupPitcherSeasonEra;
export const resolveStarterPitcher = productionResolver.resolveStarterPitcher;
export const resolveLineupStarter = productionResolver.resolveLineupStarter;
