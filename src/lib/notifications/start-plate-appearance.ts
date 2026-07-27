import type { BatterRecord } from "@/app/api/game-detail/route";
import type { StartPlateAppearanceEvidence } from "@/lib/notifications/start-freshness-policy";

function normalized(name: string): string {
  return name.replace(/\s+/g, "").trim();
}

/**
 * KBO BoxScore의 타석 결과 셀 + 현재 타자로 첫 타석 진행 여부를 확정한다.
 * HBP/희생/실책도 plateAppearances 셀 수에 포함되며, 근거 누락은 null로 fail-close한다.
 */
export function deriveStartPlateAppearanceEvidence(
  awayBatters: readonly BatterRecord[] | null | undefined,
  currentBatterRaw: string | null | undefined,
): StartPlateAppearanceEvidence | null {
  const leadoff = awayBatters?.find((b) => b.order === 1 && !b.isSubstitute) ?? null;
  const currentBatter = normalized(currentBatterRaw ?? "");
  if (!leadoff || !currentBatter) return null;

  const currentBatterIsLeadoff = normalized(leadoff.name) === currentBatter;
  const anyCompletedAwayPa = awayBatters?.some((b) => b.plateAppearances != null
    ? b.plateAppearances > 0
    : b.atBats > 0 || b.bb > 0 || b.hits > 0 || b.so > 0) ?? false;
  return {
    completedPlateAppearances: currentBatterIsLeadoff && !anyCompletedAwayPa ? 0 : 1,
    currentBatterIsLeadoff,
  };
}
