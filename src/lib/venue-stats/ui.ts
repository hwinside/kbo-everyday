import type {
  A1Value,
  MetricEnvelope,
  MetricId,
  VenueStatsScopePayload,
} from "@/lib/venue-stats/types";

export const VENUE_STATS_UI_GROUPS = {
  hero: ["A1"],
  splits: ["A2", "A3", "A4", "A5", "A6"],
  team: ["B1", "B2", "B3", "B4"],
  favorites: ["C1", "C2", "C4", "C5", "C6"],
  story: ["D1", "D5", "D6"],
  habits: ["E1", "E2", "E3", "E4"],
} as const satisfies Record<string, readonly MetricId[]>;

export const METRIC_STATE_LABELS: Record<string, string> = {
  unsupported: "지원하지 않는 시즌",
  empty: "기록 없음",
  attendance_only: "비교 데이터 준비 중",
  invalid_snapshot: "응원팀 기록 확인 필요",
  mixed_team: "응원팀 변경 포함",
  partial_data: "일부 기록 확인 중",
  no_final: "종료 경기 없음",
  no_favorite: "최애 선수 미설정",
  sample_limited: "표본 부족",
  ready: "집계 완료",
  no_wins: "승리 기록 없음",
};

export function formatRate(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value) ? "–" : `${(value * 100).toFixed(digits)}%`;
}

export function formatAvg(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "–";
  return value.toFixed(3).replace(/^0/, "");
}

export function formatEra(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "–" : value.toFixed(2);
}

export function formatSigned(
  value: number | null | undefined,
  digits: number,
  suffix = "",
): string {
  if (value == null || !Number.isFinite(value)) return "–";
  const fixed = Math.abs(value).toFixed(digits);
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${fixed}${suffix}`;
}

export function formatOuts(outs: number | null | undefined): string {
  if (outs == null || !Number.isFinite(outs)) return "–";
  const whole = Math.floor(outs / 3);
  const rest = outs % 3;
  return rest === 0 ? `${whole}` : `${whole} ${rest === 1 ? "⅓" : "⅔"}`;
}

export interface VenueStatsHero {
  score: number | null;
  attendance: A1Value["attendance"] | null;
  teamRate: number | null;
  deltaPp: number | null;
  mixedTeam: boolean;
  teamIds: number[];
}

export function buildVenueStatsHero(scope: VenueStatsScopePayload): VenueStatsHero {
  const metric = scope.metrics.A1 as MetricEnvelope<A1Value>;
  const value = metric.value;
  const attendance = value?.attendance ?? null;
  const rate = attendance?.rate ?? null;
  const teamIds = new Set<number>();
  if (value?.teamComparable?.teamId != null) teamIds.add(value.teamComparable.teamId);
  for (const item of metric.items ?? []) {
    const teamId = Number(item.key);
    if (Number.isInteger(teamId)) teamIds.add(teamId);
  }
  return {
    // S1 계약에 별도 합성 점수는 없다. A1 직관 승률(0~1)을 0~100으로만 표시한다.
    score: rate == null ? null : Math.round(rate * 100),
    attendance,
    teamRate: value?.teamComparable?.rate ?? null,
    deltaPp: value?.deltaPp ?? null,
    mixedTeam: metric.state === "mixed_team",
    teamIds: [...teamIds],
  };
}

export function metricEvidence(metric: MetricEnvelope): string {
  const bits: string[] = [];
  const d = metric.denominator ?? {};
  const games =
    d.finalGames ??
    d.attendanceFinalGames ??
    d.attendanceGames ??
    d.eligibleTeamFinalGames;
  if (typeof games === "number") bits.push(`경기 ${games}`);
  const ab = d.attendanceAB;
  if (typeof ab === "number") bits.push(`AB ${ab}`);
  const outs = d.attendanceOuts;
  if (typeof outs === "number") bits.push(`IP ${formatOuts(outs)}`);
  if (bits.length === 0) bits.push(`표본 ${metric.n}`);
  return bits.join(" · ");
}

export function coverageCaption(scope: VenueStatsScopePayload): string {
  const { attendanceGames, finalGames, incompleteFinalGames, unavailableGames } = scope.coverage;
  const gaps = incompleteFinalGames + unavailableGames;
  return gaps > 0
    ? `직관 ${attendanceGames}경기 · 종료 ${finalGames}경기 · 확인 중 ${gaps}경기`
    : `직관 ${attendanceGames}경기 · 종료 ${finalGames}경기 · 기록 확인 완료`;
}
