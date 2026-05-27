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
  bat: BatSide;
  throws: ThrowSide;
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

export interface VsHandLine {
  /** 현재 매치업 상대 손잡이 행 */
  row: SplitRow;
  /** 비교 컨텍스트: 누구의 어느 손잡이 split인가 */
  player: "batter" | "pitcher";
  opponentSide: Side;
}

export interface BasesLoadedLine {
  row: SplitRow;
  player: "batter" | "pitcher";
}

export interface RispLine {
  AVG: string;
  AB: number;
}

export interface TwoOutsLine {
  row: SplitRow;
  player: "batter" | "pitcher";
}

export interface PhBaLine {
  AVG: string;
  AB: number;
}

export interface ContextualLines {
  vsHand: LineResult<VsHandLine> | null;
  basesLoaded: LineResult<BasesLoadedLine> | null;
  risp: LineResult<RispLine> | null;
  twoOuts: LineResult<TwoOutsLine> | null;
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
