/**
 * Context gates + sample-size thresholds for /api/contextual-stats.
 *
 * Each `select*` function takes parsed source data + the live game context
 * and returns a LineResult or null. Returning null = do not render this line.
 *
 * Pair selectors (vsHand/basesLoaded/risp/twoOuts) return single-side
 * fallback: if one side fails the gate/threshold the other side still
 * shows. Only when BOTH sides fail do we null the line.
 *
 * Spec refs: §5-4 sample thresholds, §5-6 context gates (페어 결측 처리).
 */

import { aggregateRisp } from "./situation-parser";
import type {
  BasicSeasonStats,
  GameContext,
  LineResult,
  PairedSplitLine,
  PhBaLine,
  PlayerHandedness,
  RispPair,
  RispSideInfo,
  SituationTables,
  SplitRow,
  SplitSideInfo,
  VsHandPair,
  VsHandSideInfo,
} from "./types";

// ===== Sample-size thresholds =====

export const SAMPLE_THRESHOLDS = {
  basesLoaded: 5,
  risp: 10,
  vsHand: 30,
  twoOuts: 20,
} as const;

function meetsThreshold(row: SplitRow | undefined, minAB: number): row is SplitRow {
  return !!row && row.AB >= minAB;
}

function findRow(rows: SplitRow[], label: string): SplitRow | undefined {
  return rows.find(r => r.label === label);
}

export interface PlayerRef {
  kboId: string;
  name: string;
}

// ===== Context predicates =====

export function isBasesLoaded(ctx: GameContext): boolean {
  return ctx.bases.first && ctx.bases.second && ctx.bases.third;
}

export function isRisp(ctx: GameContext): boolean {
  return ctx.bases.second || ctx.bases.third;
}

export function isTwoOuts(ctx: GameContext): boolean {
  return ctx.outs === 2;
}

export function isSeventhInningOrLater(ctx: GameContext): boolean {
  return ctx.inning >= 7;
}

// ===== Pair selectors =====

/**
 * vs-hand row matched to the *opponent's* side, both directions:
 *   batter 측 → batter Situation의 "vs {pitcher.throws}투수" 행
 *   pitcher 측 → pitcher Situation의 "vs {batter.bat}타자" 행
 *
 * 양타자(switch)는 *그 타석 어느 손잡이로 들어왔는지* KBO 데이터에서 즉시
 * 알기 어려워 batter 측 vsHand만 conservative skip. pitcher 측은 모른다.
 * (양타자의 그 타석 실손잡이 미해결 → pitcher 측도 skip.)
 */
export function selectVsHandPair(
  batterSituation: SituationTables | null,
  pitcherSituation: SituationTables | null,
  batterHandedness: PlayerHandedness | null,
  pitcherHandedness: PlayerHandedness | null,
  batter: PlayerRef | null,
  pitcher: PlayerRef | null,
): LineResult<VsHandPair> | null {
  let pitcherSide: VsHandSideInfo | null = null;
  let batterSide: VsHandSideInfo | null = null;

  // pitcher 측: pitcher Situation에서 batter의 bat 손잡이 행. 양타자/미상
  // (switch/null) skip.
  const batterBat = batterHandedness?.bat;
  if (
    pitcherSituation &&
    pitcher &&
    (batterBat === "left" || batterBat === "right")
  ) {
    const targetLabel = batterBat === "left" ? "좌타자" : "우타자";
    const row = findRow(pitcherSituation.byHand, targetLabel);
    if (meetsThreshold(row, SAMPLE_THRESHOLDS.vsHand)) {
      pitcherSide = {
        kboId: pitcher.kboId,
        name: pitcher.name,
        row,
        opponentSide: batterBat,
      };
    }
  }

  // batter 측: batter Situation에서 pitcher의 throws 손잡이 행.
  // Table 4 batter rows: "좌투수" | "우투수" | "언더투수".
  // 양타자(switch)는 그 타석 실손잡이 미상 → batter 측도 skip (대칭).
  const pitcherThrows = pitcherHandedness?.throws;
  if (
    batterSituation &&
    batter &&
    (pitcherThrows === "left" || pitcherThrows === "right") &&
    batterBat !== "switch"
  ) {
    const targetLabel = pitcherThrows === "left" ? "좌투수" : "우투수";
    const row = findRow(batterSituation.byHand, targetLabel);
    if (meetsThreshold(row, SAMPLE_THRESHOLDS.vsHand)) {
      batterSide = {
        kboId: batter.kboId,
        name: batter.name,
        row,
        opponentSide: pitcherThrows,
      };
    }
  }

  if (!pitcherSide && !batterSide) return null;
  return {
    value: { batter: batterSide, pitcher: pitcherSide },
    reason: [
      batterSide ? `batter vs ${batterSide.opponentSide}투수, AB=${batterSide.row.AB}` : null,
      pitcherSide ? `pitcher vs ${pitcherSide.opponentSide}타자, AB=${pitcherSide.row.AB}` : null,
    ]
      .filter(Boolean)
      .join(" | "),
  };
}

function selectSplitRowSide(
  situation: SituationTables | null,
  source: "bases" | "byOuts",
  label: string,
  minAB: number,
  player: PlayerRef | null,
): SplitSideInfo | null {
  if (!situation || !player) return null;
  const rows = source === "bases" ? situation.bases : situation.byOuts;
  const row = findRow(rows, label);
  if (!meetsThreshold(row, minAB)) return null;
  return { kboId: player.kboId, name: player.name, row };
}

export function selectBasesLoadedPair(
  batterSituation: SituationTables | null,
  pitcherSituation: SituationTables | null,
  ctx: GameContext,
  batter: PlayerRef | null,
  pitcher: PlayerRef | null,
): LineResult<PairedSplitLine> | null {
  if (!isBasesLoaded(ctx)) return null;
  const batterSide = selectSplitRowSide(
    batterSituation,
    "bases",
    "만루",
    SAMPLE_THRESHOLDS.basesLoaded,
    batter,
  );
  const pitcherSide = selectSplitRowSide(
    pitcherSituation,
    "bases",
    "만루",
    SAMPLE_THRESHOLDS.basesLoaded,
    pitcher,
  );
  if (!batterSide && !pitcherSide) return null;
  return {
    value: { batter: batterSide, pitcher: pitcherSide },
    reason: [
      batterSide ? `batter 만루, AB=${batterSide.row.AB}` : null,
      pitcherSide ? `pitcher 만루, AB=${pitcherSide.row.AB}` : null,
    ]
      .filter(Boolean)
      .join(" | "),
  };
}

/**
 * RISP — batter side aggregates Situation Table 0의 RISP 행. 투수 Situation은
 * AVG만 있고 실제 AB가 없어 H+BB+SO proxy로 피안타율을 재계산하면 오표기다.
 * 실제 denominator 확보 전까지 pitcher RISP는 fail-closed로 숨긴다.
 *
 * 왜 Basic.aspx의 RISP 컬럼 안 쓰나: AVG 3자리 문자열만 있고 AB 없음 → 표본
 * 가드 적용 불가, "1/2 .500" 노이즈 leak (삼순이 NO-GO #1).
 */
export function selectRispPair(
  batterSituation: SituationTables | null,
  pitcherSituation: SituationTables | null,
  ctx: GameContext,
  batter: PlayerRef | null,
  pitcher: PlayerRef | null,
): LineResult<RispPair> | null {
  void pitcherSituation;
  void pitcher;
  if (!isRisp(ctx)) return null;

  let batterSide: RispSideInfo | null = null;
  if (batterSituation && batter) {
    const agg = aggregateRisp(batterSituation.bases);
    if (agg && agg.AB >= SAMPLE_THRESHOLDS.risp) {
      batterSide = { kboId: batter.kboId, name: batter.name, AVG: agg.AVG, AB: agg.AB };
    }
  }

  const pitcherSide: RispSideInfo | null = null;

  if (!batterSide) return null;
  return {
    value: { batter: batterSide, pitcher: pitcherSide },
    reason: `batter RISP, AB=${batterSide.AB}`,
  };
}

export function selectTwoOutsPair(
  batterSituation: SituationTables | null,
  pitcherSituation: SituationTables | null,
  ctx: GameContext,
  batter: PlayerRef | null,
  pitcher: PlayerRef | null,
): LineResult<PairedSplitLine> | null {
  if (!isTwoOuts(ctx)) return null;
  const batterSide = selectSplitRowSide(
    batterSituation,
    "byOuts",
    "2아웃",
    SAMPLE_THRESHOLDS.twoOuts,
    batter,
  );
  const pitcherSide = selectSplitRowSide(
    pitcherSituation,
    "byOuts",
    "2아웃",
    SAMPLE_THRESHOLDS.twoOuts,
    pitcher,
  );
  if (!batterSide && !pitcherSide) return null;
  return {
    value: { batter: batterSide, pitcher: pitcherSide },
    reason: [
      batterSide ? `batter 2아웃, AB=${batterSide.row.AB}` : null,
      pitcherSide ? `pitcher 2아웃, AB=${pitcherSide.row.AB}` : null,
    ]
      .filter(Boolean)
      .join(" | "),
  };
}

export function selectPhBA(
  basic: BasicSeasonStats | null,
  ctx: GameContext,
): LineResult<PhBaLine> | null {
  if (!basic || !basic.phBA) return null;
  if (!ctx.batterIsPinch) return null;
  const avg = basic.phBA.trim();
  if (!/^\.?\d{1,3}$|^0?\.\d{1,3}$/.test(avg)) return null;
  return {
    value: { AVG: avg, AB: 0 },
    reason: "batter PH-BA, current batter is pinch hitter",
  };
}

// ===== Highlights (trigger-only) =====

/**
 * No-hitter progress. 7회 이후 + 수비 팀 전체 pitcher rows H 합산=0 시.
 * 자세한 사유는 PR #118 코드 주석 참조.
 */
export function selectNoHitter(
  defendingTeamHits: number | null,
  ctx: GameContext,
): { inning: number } | null {
  if (defendingTeamHits === null) return null;
  if (!isSeventhInningOrLater(ctx)) return null;
  if (defendingTeamHits > 0) return null;
  return { inning: ctx.inning };
}
