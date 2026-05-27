/**
 * Types for /api/contextual-stats — the box between 문자중계 and chat that
 * surfaces situational stats matched to the current at-bat.
 *
 * Each "line" is null when its context gate fails OR its sample-size threshold
 * is unmet OR upstream source data is missing. The UI mounts only non-null
 * lines (fail-closed; never render a half-empty box).
 *
 * See specs/community/gamechat-contextual-stats-v1.md for the design spec.
 */

export type Side = "left" | "right";
export type BatSide = Side | "switch";
export type ThrowSide = Side;

export interface PlayerHandedness {
  kboId: string;
  name: string;
  /** 타자만 의미. 투수 페이지("투수(좌투)")는 bat 정보 없음 → null */
  bat: BatSide | null;
  /** 투수 측은 필수, 타자 측은 통상 채워짐 */
  throws: ThrowSide | null;
}

export interface SplitRow {
  /** 라벨: "좌타자" | "우타자" | "만루" | "1,2루" | "2아웃" 등 */
  label: string;
  AVG: string;
  AB: number;
  H: number;
  HR: number;
  BB: number;
  SO: number;
  RBI?: number;
}

export interface SituationTables {
  /** Table 0: 주자 상황별 (주자없음/1루/2루/3루/1,2루/1,3루/2,3루/만루) */
  bases: SplitRow[];
  /** Table 4: 손잡이별 (타자 → 좌투수/우투수/언더투수, 투수 → 좌타자/우타자) */
  byHand: SplitRow[];
  /** Table 5: 아웃카운트별 (0아웃/1아웃/2아웃) */
  byOuts: SplitRow[];
}

export interface BasicSeasonStats {
  kboId: string;
  name: string;
  /** RISP 타율 — 타자만 의미. 시즌 누적치 */
  risp?: string;
  /** PH-BA — 대타 시 타율. 타자만 의미 */
  phBA?: string;
  /** 시즌 HR — 마일스톤 잔여 계산용 */
  hr?: number;
  /** 시즌 RBI — 마일스톤 */
  rbi?: number;
  /** 시즌 K — 투수 마일스톤 */
  so?: number;
  /** 시즌 1위 HR (HR leader 기준치) */
  leagueHrLeader?: number;
}

/** 박스의 각 라인. null = 미노출 (게이트 실패 / 표본 부족 / 출처 결측). */
export interface LineResult<T> {
  value: T;
  /** 디버그용 — 어떤 게이트를 통과했는지 추적 */
  reason: string;
}

/**
 * 페어 라인의 한쪽(타자 또는 투수) 정보. 양쪽 모두 옵셔널이라 한쪽이
 * 게이트 실패해도 다른 쪽이 통과하면 라인은 살아남음 (single-side fallback,
 * 스펙 §5-6 페어 결측 처리).
 */
export interface SplitSideInfo {
  kboId: string;
  name: string;
  row: SplitRow;
}

export interface PairedSplitLine {
  batter: SplitSideInfo | null;
  pitcher: SplitSideInfo | null;
}

/**
 * vsHand 양쪽 모두 *상대편* 손잡이 행. opponentSide는 그 쪽이 본
 * "vs ?" 손잡이 (타자 측 → 상대 투수 throws / 투수 측 → 상대 타자 bat).
 */
export interface VsHandSideInfo extends SplitSideInfo {
  opponentSide: Side;
}

export interface VsHandPair {
  batter: VsHandSideInfo | null;
  pitcher: VsHandSideInfo | null;
}

/**
 * RISP는 Situation Table 0의 RISP 행들을 집계한 AVG/AB라 row 구조가 없음.
 */
export interface RispSideInfo {
  kboId: string;
  name: string;
  AVG: string;
  AB: number;
}

export interface RispPair {
  batter: RispSideInfo | null;
  pitcher: RispSideInfo | null;
}

export interface PhBaLine {
  AVG: string;
  AB: number;
}

export interface ContextualLines {
  vsHand: LineResult<VsHandPair> | null;
  basesLoaded: LineResult<PairedSplitLine> | null;
  risp: LineResult<RispPair> | null;
  twoOuts: LineResult<PairedSplitLine> | null;
  /** PH-BA는 KBO에 투수 측 동치(대타 상대 피안타율) 컬럼이 없어 batter-only. */
  phBA: LineResult<PhBaLine> | null;
}

export interface CycleHighlight {
  remaining: Array<"1루타" | "2루타" | "3루타" | "홈런">;
  hit: Array<"1루타" | "2루타" | "3루타" | "홈런">;
}

export interface NoHitterHighlight {
  inning: number;
}

export interface MilestoneHighlight {
  /** "30HR" | "100타점" | "200K" 같은 표시 라벨 */
  label: string;
  remaining: number;
}

export interface HrLeaderHighlight {
  /** 현재 hr 동률·1걸음 차이 등 boxscore 확정 시 표시 */
  rankAfterConfirm: number;
  /** 1위와 격차 (HR 단위) */
  gapToLeader: number;
}

export interface ContextualHighlights {
  cycle: LineResult<CycleHighlight> | null;
  noHitter: LineResult<NoHitterHighlight> | null;
  milestone: LineResult<MilestoneHighlight> | null;
  hrLeader: LineResult<HrLeaderHighlight> | null;
}

export interface GameContext {
  gameId: string;
  inning: number;
  isTop: boolean;
  outs: number;
  balls: number;
  strikes: number;
  bases: { first: boolean; second: boolean; third: boolean };
  batterKboId: string | null;
  pitcherKboId: string | null;
  batterName: string | null;
  pitcherName: string | null;
  batterIsPinch: boolean;
}

export interface ContextualStatsResponse {
  gameId: string;
  context: GameContext;
  lines: ContextualLines;
  highlights: ContextualHighlights;
  fetchedAt: string;
  /** true면 박스 전체 unmount (모든 라인 null + 모든 트리거 null). */
  empty: boolean;
}
