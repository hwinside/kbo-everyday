import type {
  A1Value,
  MetricEnvelope,
  MetricId,
  VenueStatsScopePayload,
} from "@/lib/venue-stats/types";
// 순수 leaf 모듈 — aggregate.ts 는 node 전용 의존을 끌어서 클라이언트 번들에 넣으면 안 된다.
import { MIN_FINAL_GAMES } from "@/lib/venue-stats/state";

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
  // 표본 가드 미달이어도 사실값(승·패·무·비율)은 노출하고 이 배지로만 경고한다.
  // (값을 숨기면 2경기 기록이 `0승 0패 · 승률 –`으로 보여 더 나쁜 오정보가 된다 — 2026-07-31 하린아빠 결정)
  sample_limited: "표본 부족(참고용)",
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
  /**
   * 표본 미달 여부(참고용 계약 적용 대상).
   * `state === "sample_limited"` 뿐 아니라 mixed_team 이어도 총 final < MIN_FINAL_GAMES 면 true —
   * 파이프라인에서 복수 팀은 표본 가드보다 먼저 mixed_team 으로 확정되어 표본 미달이 가려진다.
   */
  sampleLimited: boolean;
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
  // 표본 미달이면 사실값(W/L/D·승률)만 노출하고 파생 '요정 지수'는 확정값처럼 보이지 않게 비운다.
  // (2승 0패 → score 100 같은 과대 확정 표기 차단 — 2026-07-31 삼순 리뷰)
  //
  // ⚠️ state 열거로 막으면 계속 구멍이 생긴다. 판정 사다리에서 mixed_team·attendance_only 등이
  // sample_limited 보다 먼저 확정되므로, state 가 무엇이든 실제 종료 경기수가 가드 미만이면
  // 참고용 계약을 적용한다 (삼순 P0-2 mixed / P0-1 attendance_only 연속 재발 → 사실 기준으로 결속).
  //
  // `ready` 는 집계가 이미 표본을 보장한 상태라 그대로 둔다. 그 밖의 state 에서만
  // 실제 종료 경기수로 한 번 더 막는다 — mixed_team·attendance_only 등이 사다리 앞쪽에서
  // 확정되면 표본 미달이 state 에 가려지기 때문이다.
  const finalGames = metric.denominator?.attendanceFinalGames ?? metric.n;
  const sampleLimited =
    metric.state === "sample_limited" ||
    (metric.state !== "ready" && finalGames < MIN_FINAL_GAMES);
  return {
    // S1 계약에 별도 합성 점수는 없다. A1 직관 승률(0~1)을 0~100으로만 표시한다.
    score: sampleLimited || rate == null ? null : Math.round(rate * 100),
    attendance,
    teamRate: value?.teamComparable?.rate ?? null,
    deltaPp: value?.deltaPp ?? null,
    mixedTeam: metric.state === "mixed_team",
    teamIds: [...teamIds],
    sampleLimited,
  };
}

/**
 * A2~A6 스플릿 cell 목록.
 *
 * 집계는 표본 충족 cell 만 top-level `value` 에 두고, 표본 미달 cell 은 `items[].value` 에만
 * 사실값을 보존한다. UI 가 top-level 만 읽으면 "두산전 1승" 같은 실제 기록이
 * `표시할 기록이 없어요` 로 사라진다(삼순 P0-2). items 를 우선해 합친다.
 *
 * items 가 없는 구버전 payload 는 top-level 로 폴백한다.
 */
export function splitCells<T>(metric: MetricEnvelope): Array<{ key: string; cell: T; sampleLimited: boolean }> {
  const items = metric.items ?? [];
  if (items.length > 0) {
    return items
      .filter((item) => item.value != null)
      .map((item) => ({
        key: item.key,
        cell: item.value as T,
        sampleLimited: item.state === "sample_limited",
      }));
  }
  return ((metric.value as T[] | null) ?? []).map((cell, index) => ({
    key: String(index),
    cell,
    sampleLimited: false,
  }));
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
