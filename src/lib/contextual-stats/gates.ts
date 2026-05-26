/**
 * Context gates + sample-size thresholds for /api/contextual-stats.
 *
 * Each `select*` function takes the parsed source data + the live game
 * context, and returns a LineResult (with the matched row and a reason
 * string) or null. Returning null means "do not render this line".
 *
 * Spec references: §5-4 (sample thresholds), §5-6 (context gates).
 */

import { aggregateRisp } from "./situation-parser";
import type {
  BasesLoadedLine,
  BasicSeasonStats,
  GameContext,
  LineResult,
  PhBaLine,
  PlayerHandedness,
  RispLine,
  Side,
  SituationTables,
  SplitRow,
  TwoOutsLine,
  VsHandLine,
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

// ===== Line selectors =====

/**
 * vs-hand row matched to the *opponent's* side. Spec §5-6:
 *   우타자 타석 → 투수의 "vs 우타자" 행 only
 *   좌타자 타석 → 투수의 "vs 좌타자" 행 only
 *
 * Caller passes the *current matchup's batter handedness*, and we pull the
 * pitcher Situation row whose label matches that side. (Symmetric: a batter
 * page would surface the row keyed on pitcher's throws side.)
 */
export function selectVsHand(
  pitcherSituation: SituationTables | null,
  batterHandedness: PlayerHandedness | null,
): LineResult<VsHandLine> | null {
  if (!pitcherSituation || !batterHandedness) return null;
  if (batterHandedness.bat === "switch") {
    // 양타자 = depends on the pitcher's throws side, which we don't have on
    // *this* path (we have the pitcher's Situation, not their throws). The
    // route layer can choose either side; v1 conservatively suppresses.
    return null;
  }
  const targetLabel: string =
    batterHandedness.bat === "left" ? "좌타자" : "우타자";
  const row = findRow(pitcherSituation.byHand, targetLabel);
  if (!meetsThreshold(row, SAMPLE_THRESHOLDS.vsHand)) return null;
  return {
    value: {
      row,
      player: "pitcher",
      opponentSide: batterHandedness.bat as Side,
    },
    reason: `pitcher vs ${targetLabel}, AB=${row.AB}`,
  };
}

export function selectBasesLoaded(
  batterSituation: SituationTables | null,
  ctx: GameContext,
): LineResult<BasesLoadedLine> | null {
  if (!batterSituation) return null;
  if (!isBasesLoaded(ctx)) return null;
  const row = findRow(batterSituation.bases, "만루");
  if (!meetsThreshold(row, SAMPLE_THRESHOLDS.basesLoaded)) return null;
  return {
    value: { row, player: "batter" },
    reason: `batter 만루 split, AB=${row.AB}`,
  };
}

/**
 * RISP derived from Situation Table 0 — aggregates AB/H across all RISP
 * rows (2루·3루·1,2루·1,3루·2,3루·만루) so the §5-4 sample-size gate has a
 * real AB to threshold against.
 *
 * Why not the Basic.aspx RISP column: that column only ships a 3-digit AVG
 * string with no AB, so noise like "1/2 → .500" leaks through (삼순이
 * NO-GO #1).
 */
export function selectRisp(
  batterSituation: SituationTables | null,
  ctx: GameContext,
): LineResult<RispLine> | null {
  if (!batterSituation) return null;
  if (!isRisp(ctx)) return null;
  const agg = aggregateRisp(batterSituation.bases);
  if (!agg) return null;
  if (agg.AB < SAMPLE_THRESHOLDS.risp) return null;
  return {
    value: { AVG: agg.AVG, AB: agg.AB },
    reason: `batter Situation-aggregated RISP, AB=${agg.AB}`,
  };
}

export function selectTwoOuts(
  situation: SituationTables | null,
  ctx: GameContext,
  player: "batter" | "pitcher",
): LineResult<TwoOutsLine> | null {
  if (!situation) return null;
  if (!isTwoOuts(ctx)) return null;
  const row = findRow(situation.byOuts, "2아웃");
  if (!meetsThreshold(row, SAMPLE_THRESHOLDS.twoOuts)) return null;
  return {
    value: { row, player },
    reason: `${player} 2아웃 split, AB=${row.AB}`,
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
 * No-hitter progress. Only shown from the *7th inning onward* (spec §5-5) —
 * earlier innings would lose impact and violate baseball convention.
 *
 * Critical: `hits` MUST be the *defending team's total H across all pitchers
 * that have appeared today*, not the current pitcher's individual row.
 * Otherwise a relief pitcher with 0 IP would short-circuit to "no-hitter"
 * even after the starter gave up several hits (삼순이 NO-GO #2).
 *
 * Perfect game is intentionally *not* surfaced in v1 — KBO BoxScore has no
 * explicit HBP / reached-on-error column for pitchers, and the indirect
 * BF cross-check we attempted had a half-inning calculation bug (삼순이
 * NO-GO #3). v2 will revisit once we have direct HBP/error signals.
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
