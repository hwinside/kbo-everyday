import pitcherStatsJson from "@/lib/constants/stats-2026-pitchers.json";
import { resolveRosterPlayer } from "@/lib/utils/player-roster";
import { resolvePlayerIdentity, resolveRosterCandidates } from "@/lib/utils/resolve-player";
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
  /** 이름+팀 → 로스터 선수(canonical kboId). 동명이인이면 null(fail-close). */
  resolveRoster: (query: { name: string; teamId: number }) => { kboId: string } | null;
  /**
   * 이름+팀으로 걸리는 **모든** 후보. 동명이인일 때 역할(투수 기록 보유)로 좁히기 위해 쓴다.
   * 없으면 좁히기를 시도하지 않는다(주입 안 한 테스트는 기존 의미론 그대로).
   */
  resolveRosterCandidates?: (query: { name: string; teamId: number }) => { kboId: string }[];
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
  resolveRosterCandidates: resolveCandidates,
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

  /**
   * 이름+팀이 모호할 때(동명이인) **투수 기록 보유**라는 역할로 한 명을 확정한다.
   *
   * `resolveRoster` 는 모호하면 null 을 준다 — 배열 순서로 찍지 않기 위해서다(2026-08-08).
   * 하지만 여기서 찾는 건 "선발 투수"이므로 후보 중 시즌 투수 기록이 있는 사람이 답이다.
   * 실측 기준 7개 모호 그룹 중 4개가 이 규칙으로 갈린다.
   * 좁혀도 복수면(둘 다 투수 기록 보유) **확정하지 않는다** — 틀린 ERA 를 보여주느니 "-" 가 낫다.
   */
  function resolvePitcherByRole(name: string, teamId: number): string | undefined {
    const direct = resolveRoster({ name, teamId });
    if (direct?.kboId) return direct.kboId;
    if (!resolveCandidates) return undefined;

    const withEra = resolveCandidates({ name, teamId }).filter(
      (candidate) => lookupPitcherSeasonEra(candidate.kboId) !== null,
    );
    return withEra.length === 1 ? withEra[0].kboId : undefined;
  }

  function resolveStarterPitcher(
    name: string,
    teamId: number,
    boxEra?: string | null,
    boxPitcherName?: string | null,
  ): { name: string; era: string; kboId?: string } {
    const starterKboId = name ? resolvePitcherByRole(name, teamId) : undefined;
    const boxKboId = boxPitcherName ? resolvePitcherByRole(boxPitcherName, teamId) : undefined;
    const boxMatchesStarter = Boolean(
      boxPitcherName && (
        (starterKboId && boxKboId === starterKboId)
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
  resolveRosterCandidates: ({ name, teamId }) => resolveRosterCandidates({ name, teamId }),
  toNumericId: (kboId) => resolvePlayerIdentity(kboId)?.numericId,
});

export const lookupPitcherSeasonEra = productionResolver.lookupPitcherSeasonEra;
export const resolveStarterPitcher = productionResolver.resolveStarterPitcher;
export const resolveLineupStarter = productionResolver.resolveLineupStarter;
