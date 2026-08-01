/**
 * 직관 다이어리 통계 S1b — v1 22종 payload/envelope 계약 타입.
 * spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §9(envelope)·§10(ID별 payload)·§11(component/empty)
 *
 * MetricEnvelope={ id,state,value:T|null,n,denominator,coverage,reasons?,components?,items? } (§9 exact).
 * 합성 metric은 outer state만으로 세부 상태를 숨기지 않고 component/item envelope를 의무 사용한다.
 */
import type { ComponentState, MetricState } from "@/lib/venue-stats/state";

export const METRIC_IDS = [
  "A1", "A2", "A3", "A4", "A5", "A6",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C4", "C5", "C6",
  "D1", "D5", "D6",
  "E1", "E2", "E3", "E4",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

/** §9 Component<T>={ state,value,n,denominator,coverage,reasons? } — leaf 전용 no_wins 허용. */
export interface ComponentEnvelope<T = unknown> {
  state: ComponentState;
  value: T | null;
  n: number;
  denominator: Record<string, number>;
  coverage?: Record<string, unknown>;
  reasons?: string[];
}

/** §9 ItemEnvelope={ key,state,value,n,denominator,coverage,reasons? }. */
export interface ItemEnvelope<T = unknown> {
  key: string;
  state: MetricState;
  value: T | null;
  n: number;
  denominator: Record<string, number>;
  coverage?: Record<string, unknown>;
  reasons?: string[];
}

export interface MetricEnvelope<T = unknown> {
  id: MetricId;
  state: MetricState;
  value: T | null;
  n: number;
  denominator: Record<string, number>;
  coverage: Record<string, unknown>;
  reasons?: string[];
  components?: Record<string, ComponentEnvelope>;
  items?: ItemEnvelope[];
}

/** W/(W+L+D) 동일 분모 승패 집계 (§9 A1 승률 산식 — KBO 공식 W/(W+L)은 officialWinRate 메타로만). */
export interface WinLossDraw {
  w: number;
  l: number;
  d: number;
  /** W/(W+L+D). 분모 0이면 null (§11 — NaN/0 위조 금지). */
  rate: number | null;
}

export interface TeamComparable extends WinLossDraw {
  teamId: number;
}

/** §10 A1 — 단일 snapshot 팀이면 delta, 복수 팀이면 mixed_team·items=perTeam (§11 mixed shape). */
/**
 * 직관 경기의 **경기 시작 전(pregame) 기대치 대비 초과성과**.
 *
 * 하린아빠 2026-08-02: "관전가치 기준이 아니라 무조건 팀퍼포먼스와의 상관도를 봐야지".
 * 삼순 2026-08-02: 대상 경기·이후 경기가 섞인 시즌 누적값은 leakage — 반드시 경기일 이전 데이터로만.
 * 한 경기라도 pregame 기대치를 못 만들면 null — 축 재정규화가 아니라 지수 전체 fail-close.
 */
export interface AttendanceExcess {
  /** 경기당 평균 (실제 승점 − 기대 승률). -1~1. */
  winExcess: number;
  /** 경기당 평균 (실제 마진 − 기대 마진), 점. */
  marginExcess: number;
  /** 초과성과를 산출한 경기 수. */
  games: number;
}

export interface A1Value {
  attendance: WinLossDraw;
  teamComparable: TeamComparable | null;
  deltaPp: number | null;
  /** pregame 기대치 대비 초과성과. null=기대치 불가 → 요정 지수 fail-close. */
  excess?: AttendanceExcess | null;
}

export interface A2Cell extends WinLossDraw { opponentTeamId: number }
export interface A3Cell extends WinLossDraw { stadium: string; homeAway: "home" | "away" }
/** weekday: KST 요일 0(일)~6(토). */
export interface A4Cell extends WinLossDraw { weekday: number }
/** §10 A5 — 시작 18:00 KST 미만=day, 이상=night. */
export interface A5Cell extends WinLossDraw { dayNight: "day" | "night" }
export interface A6Cell extends WinLossDraw { month: number }

export interface B1Value {
  attendanceAvg: number | null;
  seasonAvg: number | null;
  delta: number | null;
}
export interface B2Value {
  attendanceEra: number | null;
  seasonEra: number | null;
  /** attendanceEra - seasonEra (음수가 부스트 — ERA는 낮을수록 좋음). */
  delta: number | null;
}
export interface B3Value {
  runsPerGame: number | null;
  /** 응원팀의 정규시즌 경기당 평균 득점. 시즌 경기 우주가 완전할 때만 제공. */
  seasonRunsPerGame: number | null;
  /** runsPerGame - seasonRunsPerGame. 양수가 직관 부스트. */
  delta: number | null;
  totalRuns: number;
}
export interface B4Side {
  attendancePerGame: number | null;
  seasonPerGame: number | null;
  delta: number | null;
}
export interface B4Value {
  hr: B4Side | null;
  hitsAllowed: B4Side | null;
}
/** mixed_team perTeam item용 B 묶음 payload (§10 "perTeam에 같은 타입을 팀별 반환"). */
export interface BTeamValue {
  b1: B1Value | null;
  b2: B2Value | null;
  b3: B3Value | null;
  b4: B4Value | null;
}

export interface C1Entry {
  playerId: string;
  attendanceAvg: number | null;
  seasonAvg: number | null;
  deltaAvg: number | null;
  attendanceHrPerGame: number | null;
  seasonHrPerGame: number | null;
  attendanceRbiPerGame: number | null;
  seasonRbiPerGame: number | null;
  appearances: number;
  ab: number;
}
export interface C2Entry {
  playerId: string;
  attendanceEra: number | null;
  seasonEra: number | null;
  /** §10 — seasonEra-attendanceEra (클수록 좋음). */
  eraImprovement: number | null;
  attendanceK9: number | null;
  seasonK9: number | null;
  k9Delta: number | null;
  appearances: number;
  outs: number;
}
export interface C4Entry {
  playerId: string;
  /** 기존 클라이언트 호환 필드. 신규 UI는 batter.homeRuns를 사용한다. */
  homeRuns: number;
  appearanceGames: number;
  batter: { hits: number; rbi: number; homeRuns: number } | null;
  pitcher: { strikeouts: number; zeroEarnedRunGames: number } | null;
}
export interface C5BatterTop {
  gameId: string;
  date: string;
  ab: number;
  h: number;
  hr: number;
  rbi: number;
  bb: number;
}
export interface C5PitcherTop {
  gameId: string;
  date: string;
  ipOuts: number;
  er: number;
  k: number;
  hAllowed: number;
}
export interface C5Entry {
  playerId: string;
  batterTop?: C5BatterTop;
  pitcherTop?: C5PitcherTop;
}
export interface C6Value {
  batterRanking: Array<{ playerId: string; boostPct: number }>;
  pitcherRanking: Array<{ playerId: string; boostPct: number }>;
}

export interface D1Value {
  avgRunDiff: number | null;
  closeGameRate: number | null;
  closeGames: number;
}
export interface D5Value { cancelledCount: number }
export interface D6TopGame { gameId: string; date: string; runs: number }
export interface D6MarginWin { gameId: string; date: string; margin: number }
export interface D6Value {
  maxTeamRuns: D6TopGame | null;
  maxMarginWin: D6MarginWin | null;
}

export interface E1PerTeam {
  teamId: number;
  current: number;
  longest: number;
}
export interface E1Value {
  current: number | null;
  longest: number;
  perTeam: E1PerTeam[];
}
export interface E2Value {
  seasonCount: number;
  monthly: Array<{ month: number; count: number }>;
  avgPerActiveMonth: number | null;
}
export interface E3Value {
  firstAttendanceDate: string;
  daysSinceFirst: number;
  totalGames: number;
}
export interface E4Value {
  topStadium: { name: string; count: number } | null;
  mostSeenFavorites: Array<{ playerId: string; appearances: number }>;
}

/** §10 snapshot 검증 exact — coverage.invalidSnapshot=[{gameId,reason}]. */
export type SnapshotIssueReason =
  | "snapshot_missing"
  | "snapshot_team_mismatch"
  | "game_unavailable";
export interface InvalidSnapshotEntry {
  gameId: string;
  reason: SnapshotIssueReason;
}

/** §10 C coverage exact. */
export interface FavoriteCoverage {
  eligible: number;
  complete: number;
  appearances: number;
  dnp: number;
  unknown: number;
  ratio: number | null;
  unknownGameIds: string[];
}

export type ScopeName = "overall" | "gps";

export interface VenueStatsScopeCoverage {
  attendanceGames: number;
  finalGames: number;
  cancelledGames: number;
  unavailableGames: number;
  /** overall dedupe로 접힌 중복 행 수 (같은 game_id GPS+manual → 1경기, §5). */
  dedupedRows: number;
  incompleteFinalGames: number;
  invalidSnapshot: InvalidSnapshotEntry[];
}

/** §9 Scope={ state,filter,coverage,metrics }. 두 scope는 완전히 동일한 응답 스키마 (§5). */
export interface VenueStatsScopePayload {
  state: "empty" | "ready";
  filter: { scope: ScopeName; sources: string[] };
  coverage: VenueStatsScopeCoverage;
  metrics: Record<MetricId, MetricEnvelope>;
}

/** §9 지원 시즌 상태 3종. */
export type SeasonSupportStatus = "supported" | "attendance_only" | "unsupported";
