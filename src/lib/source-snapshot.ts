export interface SourceSnapshot {
  generation: number;
  sourceAtMs: number;
  fetchedAtMs: number;
}

export function shouldCommitResponse(
  latestGeneration: number,
  responseGeneration: number,
): boolean {
  return latestGeneration === responseGeneration;
}

export function isSourceSnapshotNewer(
  candidate: SourceSnapshot | null | undefined,
  baseline: SourceSnapshot | null | undefined,
): boolean {
  if (!candidate) return false;
  if (!baseline) return true;
  if (candidate.sourceAtMs !== baseline.sourceAtMs) {
    return candidate.sourceAtMs > baseline.sourceAtMs;
  }
  return candidate.fetchedAtMs > baseline.fetchedAtMs;
}

export type LineupSource =
  | "none"
  | "kbo-unconfirmed"
  | "kbo-confirmed"
  | "naver-preview"
  | "naver-confirmed";

export function isCanonicalLineupSource(source?: LineupSource | null): boolean {
  return source === "kbo-confirmed"
    || source === "naver-confirmed"
    || source === "naver-preview";
}

export function shouldPreserveCanonicalLineup(
  previousSource?: LineupSource | null,
  incomingSource?: LineupSource | null,
): boolean {
  const rank = (source?: LineupSource | null) => (
    source === "kbo-confirmed" ? 3
      : source === "naver-confirmed" ? 2
      : source === "naver-preview" ? 1
        : 0
  );
  return rank(previousSource) > rank(incomingSource);
}

export function isLineupStarterProvenanceTrusted({
  source,
  awayBatters,
  homeBatters,
  isAllStar,
}: {
  source?: LineupSource | null;
  awayBatters: number;
  homeBatters: number;
  isAllStar: boolean;
}): boolean {
  return isAllStar
    || source === "kbo-confirmed"
    || source === "naver-confirmed"
    || (source === "naver-preview" && awayBatters === 0 && homeBatters === 0);
}
