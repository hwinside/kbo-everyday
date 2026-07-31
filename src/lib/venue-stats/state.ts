/**
 * 직관 다이어리 통계 — metric state 전역 단일 사다리 + 판정 파이프라인 (S1a 순수 로직).
 * spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §12 (이 사다리는 스펙 §12가 유일 선언 —
 * 코드에서도 이 모듈 1곳에만 선언하고 S1b/S1c는 여기서 import만 한다).
 *
 * 사다리(높은 우선순위 → 낮은 순):
 *   unsupported > empty > attendance_only > invalid_snapshot > mixed_team >
 *   partial_data > no_final > no_favorite > sample_limited > ready
 * component 전용 no_wins는 사다리 밖 leaf-only 정보성 상태 — outer worstState 순위화에서
 * 제외하고, leaf 제외 나머지가 전부 ready면 outer=ready로 승격한다(§12 leaf 승격 규칙).
 */

/** §12 전역 단일 사다리. index가 작을수록 우선순위가 높다(먼저 단락). */
export const METRIC_STATE_LADDER = [
  "unsupported",
  "empty",
  "attendance_only",
  "invalid_snapshot",
  "mixed_team",
  "partial_data",
  "no_final",
  "no_favorite",
  "sample_limited",
  "ready",
] as const;

export type MetricState = (typeof METRIC_STATE_LADDER)[number];

/**
 * §5 표본 가드 — 종료 경기 최소 수(승률·스플릿·팀 경기당 지표).
 * 클라이언트 UI 안내문과 집계 로직이 같은 임계값을 써야 해서 순수 leaf 모듈인 여기에 둔다
 * (aggregate.ts 는 node 전용 의존을 끌어서 클라이언트 번들에서 import 하면 안 된다).
 */
export const MIN_FINAL_GAMES = 3;

/** 사다리 밖 leaf-only 정보성 상태 (component envelope 전용, §11 D6 등). */
export const LEAF_ONLY_STATES = ["no_wins"] as const;
export type LeafOnlyState = (typeof LEAF_ONLY_STATES)[number];

export type ComponentState = MetricState | LeafOnlyState;

const LADDER_INDEX = new Map<MetricState, number>(
  METRIC_STATE_LADDER.map((s, i) => [s, i]),
);
const LEAF_ONLY = new Set<string>(LEAF_ONLY_STATES);

/** 사다리 우선순위 (작을수록 높음). */
export function statePriority(state: MetricState): number {
  return LADDER_INDEX.get(state)!;
}

export function isLeafOnlyState(state: ComponentState): state is LeafOnlyState {
  return LEAF_ONLY.has(state);
}

/**
 * §12 판정 파이프라인 입력. 각 필드는 metric별 적용 범위(§10 state 적용 범위)에 따라
 * 채운다 — 적용 안 되는 단계는 기본값(0/true/false)으로 통과한다.
 */
export interface MetricStateInput {
  /** 요청 season 지원 여부 (supported/attendance_only/unsupported 3종 중 unsupported 판정, §9). */
  seasonSupported: boolean;
  /** scope 내 직관 경기 수 (0이면 empty). */
  attendanceGames: number;
  /** 비교 소스 미지원(attendance_only) — A1 팀비교·B·C만 해당. 기본 true(지원). */
  comparisonSourceSupported?: boolean;
  /** snapshot 오류행(snapshot_missing/mismatch/game_unavailable) 수 — §12 ① final 선별보다 먼저 단락. */
  invalidSnapshotGames?: number;
  /** mixed_team 적용 metric(A1·B)인지. */
  mixedTeamApplies?: boolean;
  /** 서로 다른 snapshot 팀 수. */
  snapshotTeamCount?: number;
  /** partial_data 적용 metric(B·C)인지. */
  partialDataApplies?: boolean;
  /** 적재 incomplete(unknown_log_gap) 경기 수. */
  unknownGames?: number;
  /** final 경기 수 — §12 ② favorite 판정보다 먼저 단락. */
  finalGames: number;
  /** 최애 필요 metric(C)인지. */
  favoriteRequired?: boolean;
  /** 현재 최애 수. */
  favoriteCount?: number;
  /** 표본 가드 충족 여부 (§5). 기본 true. */
  sampleMet?: boolean;
}

/**
 * §12 평가 의사코드 그대로 — 위에서부터 단락, 순서 고정
 * (①snapshot 유효성 → ②final 선별 → ③favorite → ④표본).
 * cancelled-only(final=0)+invalid snapshot 복합은 invalid_snapshot 단 1개.
 * no_favorite은 final≥1일 때만 도달한다(cancelled-only C = no_final).
 */
export function resolveMetricState(input: MetricStateInput): MetricState {
  if (!input.seasonSupported) return "unsupported";
  if (input.attendanceGames === 0) return "empty";
  if (input.comparisonSourceSupported === false) return "attendance_only";
  if ((input.invalidSnapshotGames ?? 0) > 0) return "invalid_snapshot";
  if (input.mixedTeamApplies && (input.snapshotTeamCount ?? 0) > 1) return "mixed_team";
  if (input.partialDataApplies && (input.unknownGames ?? 0) > 0) return "partial_data";
  if (input.finalGames === 0) return "no_final";
  if (input.favoriteRequired && (input.favoriteCount ?? 0) === 0) return "no_favorite";
  if (input.sampleMet === false) return "sample_limited";
  return "ready";
}

/**
 * outer worstState (정보 요약용, §11): 사다리 위 state만 순위화한다.
 * leaf-only(no_wins 등)는 순위화 대상에서 제외하고, leaf 제외 나머지가 전부 ready면
 * outer=ready로 승격한다(§12 leaf 승격 규칙 — D6 ready+no_wins 고정 payload 참조).
 * ready item 값은 outer state 때문에 폐기하지 않는다(호출측 계약).
 */
export function worstState(states: readonly ComponentState[]): MetricState {
  let worst: MetricState | null = null;
  for (const s of states) {
    if (isLeafOnlyState(s)) continue;
    if (worst === null || statePriority(s) < statePriority(worst)) worst = s;
  }
  return worst ?? "ready";
}
