/**
 * Context gates + sample-size thresholds for /api/contextual-stats.
 *
 * Each `select*` function takes the parsed source data + the live game
 * context, and returns a LineResult (with the matched row and a reason
 * string) or null. Returning null means "do not render this line".
 *
 * Spec references: §5-4 (sample thresholds), §5-6 (context gates).
 */

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
 * RISP uses the Basic.aspx RISP column (season-aggregated). Sample size is
 * not directly available there, so we surface it as text only and rely on
 * the RISP-bases situation rows when a stricter threshold matters.
 *
 * If the upstream parser lacked an AB count, we still display when the AVG
 * string parses as a real number — the Basic page only publishes RISP for
 * batters with non-trivial samples, so this is a soft floor.
 */
export function selectRisp(
  basic: BasicSeasonStats | null,
  ctx: GameContext,
): LineResult<RispLine> | null {
  if (!basic || !basic.risp) return null;
  if (!isRisp(ctx)) return null;
  // Strip leading "." or "0." then ensure it's a 3-digit avg-like string
  const avg = basic.risp.trim();
  if (!/^\.?\d{1,3}$|^0?\.\d{1,3}$/.test(avg) && !/^\d+\/\d+$/.test(avg)) {
    return null;
  }
  return {
    value: { AVG: avg, AB: 0 },
    reason: "batter season RISP, runner on 2B/3B",
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
 * No-hitter / perfect game progress. Only shown from the *7th inning onward*
 * (spec §5-5) — earlier innings would lose impact and violate baseball
 * convention.
 *
 * Perfect-game check (삼순이 22:44 리뷰):
 *   The KBO pitcher box row exposes IP, BF, AB, H, BB, K, R, ER but *no
 *   explicit HBP or reached-on-error column*. Reading only H and BB would
 *   silently surface "퍼펙트" while a hit-by-pitch or fielding error
 *   actually put a runner on. Anchor instead on BattersFaced:
 *
 *     perfect ⇔ H == 0 AND BB == 0 AND BF == completed_innings * 3 + outs
 *
 *   When a runner has reached on HBP/error, BF will exceed that expected
 *   total. completed_innings derives from KBO's `GAME_INN_NO` + half:
 *   `inning - 1` when the pitcher is currently on the mound mid-top, or
 *   `inning` when mid-bottom. `outs` is the current-inning out count.
 *
 *   No-hitter (the looser case where HBP / BB / errors are allowed) still
 *   gates only on H == 0.
 */
export function selectNoHitter(
  pitcherStats: { hits: number; walks: number; battersFaced: number } | null,
  ctx: GameContext,
): { perfect: boolean; inning: number } | null {
  if (!pitcherStats) return null;
  if (!isSeventhInningOrLater(ctx)) return null;
  if (pitcherStats.hits > 0) return null;

  const completedInnings = ctx.isTop ? ctx.inning - 1 : ctx.inning;
  const expectedBfForPerfect = completedInnings * 3 + ctx.outs;
  const perfect =
    pitcherStats.walks === 0 &&
    pitcherStats.battersFaced === expectedBfForPerfect;

  return { perfect, inning: ctx.inning };
}
