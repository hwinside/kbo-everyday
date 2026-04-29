/**
 * Event Generator — Diff engine for Phase 1 문자중계
 *
 * Compares previous vs current game state (LiveGameData + BoxScore)
 * to detect changes and generate GameEvent[].
 */

import type { GameEvent, GameEventType, EventDetail, GameSnapshot } from "@/types/game-events";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import type { GameDetailResponse } from "@/app/api/game-detail/route";
import { buildEventText } from "@/lib/event-text-builder";

export interface PrevGameState {
  live: LiveGameData;
  boxScore: GameDetailResponse["boxScore"];
  /** Running sequence counter for event IDs */
  seq: number;
}

let seqCounter = 0;

function nextSeq(): number {
  return ++seqCounter;
}

function makeSnapshot(live: LiveGameData): GameSnapshot {
  return {
    awayScore: live.awayScore,
    homeScore: live.homeScore,
    balls: live.balls,
    strikes: live.strikes,
    outs: live.outs,
    runners: {
      first: live.runner1bName || (live.runner1b ? "주자" : null),
      second: live.runner2bName || (live.runner2b ? "주자" : null),
      third: live.runner3bName || (live.runner3b ? "주자" : null),
    },
    pitcher: live.currentPitcher || "",
    batter: live.currentBatter || "",
  };
}

function makeEvent(
  gameId: string,
  live: LiveGameData,
  type: GameEventType,
  detail: EventDetail,
): GameEvent {
  const seq = nextSeq();
  const snapshot = makeSnapshot(live);
  const event: GameEvent = {
    id: `${gameId}-${live.inning}-${seq}`,
    gameId,
    timestamp: new Date().toISOString(),
    inning: live.inning,
    isTop: live.isTop,
    type,
    detail,
    text: "", // filled below
    snapshot,
  };
  event.text = buildEventText(event);
  return event;
}

/** Aggregate batter stats from BoxScore for diff comparison */
interface BatterAgg {
  totalHits: number;
  totalHR: number;
  totalH2B: number;
  totalH3B: number;
  totalBB: number;
  totalSO: number;
}

function aggregateBatters(
  batters: GameDetailResponse["boxScore"] extends infer T
    ? T extends { awayBatters: infer B } ? B : never
    : never,
): BatterAgg {
  if (!batters) return { totalHits: 0, totalHR: 0, totalH2B: 0, totalH3B: 0, totalBB: 0, totalSO: 0 };
  let totalHits = 0, totalHR = 0, totalH2B = 0, totalH3B = 0, totalBB = 0, totalSO = 0;
  for (const b of batters) {
    totalHits += b.hits;
    totalHR += b.hr;
    totalH2B += b.h2b;
    totalH3B += b.h3b;
    totalBB += b.bb;
    totalSO += b.so;
  }
  return { totalHits, totalHR, totalH2B, totalH3B, totalBB, totalSO };
}

function aggregatePitcherNames(
  pitchers: GameDetailResponse["boxScore"] extends infer T
    ? T extends { awayPitchers: infer P } ? P : never
    : never,
): string[] {
  if (!pitchers) return [];
  return pitchers.map(p => p.name);
}

/**
 * Generate events by diffing prev and current game state.
 */
export function generateEvents(
  gameId: string,
  prev: PrevGameState | null,
  currentLive: LiveGameData,
  currentBoxScore: GameDetailResponse["boxScore"],
): { events: GameEvent[]; nextState: PrevGameState } {
  const events: GameEvent[] = [];

  // First poll — no prev state, emit game_start if live
  if (!prev) {
    if (currentLive.isLive) {
      events.push(makeEvent(gameId, currentLive, "game_start", {}));

      // Also emit current inning
      events.push(makeEvent(gameId, currentLive, "inning_start", {
        inning: currentLive.inning,
        isTop: currentLive.isTop,
      }));
    }
    return {
      events,
      nextState: { live: currentLive, boxScore: currentBoxScore, seq: seqCounter },
    };
  }

  const prevLive = prev.live;

  // --- Game state transitions ---

  // Game just started
  if (!prevLive.isLive && currentLive.isLive) {
    events.push(makeEvent(gameId, currentLive, "game_start", {}));
  }

  // Game just ended
  if (prevLive.isLive && !currentLive.isLive && currentLive.awayScore + currentLive.homeScore > 0) {
    events.push(makeEvent(gameId, currentLive, "game_end", {}));
    return {
      events,
      nextState: { live: currentLive, boxScore: currentBoxScore, seq: seqCounter },
    };
  }

  // --- Inning change ---
  const prevInningKey = `${prevLive.inning}-${prevLive.isTop}`;
  const currInningKey = `${currentLive.inning}-${currentLive.isTop}`;

  if (prevInningKey !== currInningKey && currentLive.isLive) {
    // Previous inning ended
    events.push(makeEvent(gameId, prevLive, "inning_end", {
      inning: prevLive.inning,
      isTop: prevLive.isTop,
    }));
    // New inning started
    events.push(makeEvent(gameId, currentLive, "inning_start", {
      inning: currentLive.inning,
      isTop: currentLive.isTop,
    }));
  }

  // --- Pitcher change (via live data) ---
  if (
    prevLive.currentPitcher &&
    currentLive.currentPitcher &&
    prevLive.currentPitcher !== currentLive.currentPitcher &&
    prevInningKey === currInningKey // same inning = mid-inning change
  ) {
    events.push(makeEvent(gameId, currentLive, "pitching_change", {
      playerOut: prevLive.currentPitcher,
      playerIn: currentLive.currentPitcher,
    }));
  }

  // --- BoxScore diffs (batting stats) ---
  if (currentBoxScore && prev.boxScore) {
    // Determine which side is batting based on isTop
    const prevBatters = currentLive.isTop
      ? prev.boxScore.awayBatters
      : prev.boxScore.homeBatters;
    const currBatters = currentLive.isTop
      ? currentBoxScore.awayBatters
      : currentBoxScore.homeBatters;

    const prevAgg = aggregateBatters(prevBatters);
    const currAgg = aggregateBatters(currBatters);

    // Home run increase
    const hrDiff = currAgg.totalHR - prevAgg.totalHR;
    if (hrDiff > 0) {
      for (let i = 0; i < hrDiff; i++) {
        events.push(makeEvent(gameId, currentLive, "at_bat_homerun", {
          batter: prevLive.currentBatter || currentLive.currentBatter || undefined,
          pitcher: currentLive.currentPitcher || undefined,
        }));
      }
    }

    // 3B increase
    const h3bDiff = currAgg.totalH3B - prevAgg.totalH3B;
    if (h3bDiff > 0) {
      for (let i = 0; i < h3bDiff; i++) {
        events.push(makeEvent(gameId, currentLive, "at_bat_triple", {
          batter: prevLive.currentBatter || currentLive.currentBatter || undefined,
          pitcher: currentLive.currentPitcher || undefined,
        }));
      }
    }

    // 2B increase
    const h2bDiff = currAgg.totalH2B - prevAgg.totalH2B;
    if (h2bDiff > 0) {
      for (let i = 0; i < h2bDiff; i++) {
        events.push(makeEvent(gameId, currentLive, "at_bat_double", {
          batter: prevLive.currentBatter || currentLive.currentBatter || undefined,
          pitcher: currentLive.currentPitcher || undefined,
        }));
      }
    }

    // 1B increase (total hits minus HR/2B/3B)
    const hitDiff = (currAgg.totalHits - prevAgg.totalHits) - hrDiff - h2bDiff - h3bDiff;
    if (hitDiff > 0) {
      for (let i = 0; i < hitDiff; i++) {
        events.push(makeEvent(gameId, currentLive, "at_bat_hit", {
          batter: prevLive.currentBatter || currentLive.currentBatter || undefined,
          pitcher: currentLive.currentPitcher || undefined,
        }));
      }
    }

    // Strikeout increase
    const soDiff = currAgg.totalSO - prevAgg.totalSO;
    if (soDiff > 0) {
      for (let i = 0; i < soDiff; i++) {
        events.push(makeEvent(gameId, currentLive, "at_bat_strikeout", {
          batter: prevLive.currentBatter || undefined,
          pitcher: currentLive.currentPitcher || undefined,
        }));
      }
    }

    // Walk increase
    const bbDiff = currAgg.totalBB - prevAgg.totalBB;
    if (bbDiff > 0) {
      for (let i = 0; i < bbDiff; i++) {
        events.push(makeEvent(gameId, currentLive, "at_bat_walk", {
          batter: prevLive.currentBatter || undefined,
          pitcher: currentLive.currentPitcher || undefined,
        }));
      }
    }

    // Also check pitching side for pitcher changes via BoxScore
    const prevPitchers = currentLive.isTop
      ? prev.boxScore.homePitchers
      : prev.boxScore.awayPitchers;
    const currPitchers = currentLive.isTop
      ? currentBoxScore.homePitchers
      : currentBoxScore.awayPitchers;
    const prevPNames = aggregatePitcherNames(prevPitchers);
    const currPNames = aggregatePitcherNames(currPitchers);

    if (currPNames.length > prevPNames.length) {
      // New pitcher appeared in BoxScore
      const newPitcher = currPNames[currPNames.length - 1];
      const oldPitcher = prevPNames[prevPNames.length - 1];
      // Only emit if we didn't already detect it from live data
      const alreadyEmitted = events.some(
        e => e.type === "pitching_change" && e.detail.playerIn === newPitcher,
      );
      if (!alreadyEmitted && oldPitcher && newPitcher !== oldPitcher) {
        events.push(makeEvent(gameId, currentLive, "pitching_change", {
          playerOut: oldPitcher,
          playerIn: newPitcher,
        }));
      }
    }
  }

  // --- Score change ---
  const awayDiff = currentLive.awayScore - prevLive.awayScore;
  const homeDiff = currentLive.homeScore - prevLive.homeScore;
  const totalScoreDiff = awayDiff + homeDiff;

  if (totalScoreDiff > 0) {
    // Don't emit run_scored if we already emitted a homerun for this diff
    const hrEvents = events.filter(e => e.type === "at_bat_homerun").length;
    const runsToReport = totalScoreDiff - hrEvents;
    if (runsToReport > 0) {
      events.push(makeEvent(gameId, currentLive, "run_scored", {
        rbi: runsToReport,
      }));
    }
  }

  // --- Out count change (inferred) ---
  if (prevInningKey === currInningKey) {
    const outDiff = currentLive.outs - prevLive.outs;
    if (outDiff > 0) {
      // Only emit at_bat_out if no strikeout was already detected
      const soEvents = events.filter(e => e.type === "at_bat_strikeout").length;
      const outsToReport = outDiff - soEvents;
      for (let i = 0; i < outsToReport; i++) {
        events.push(makeEvent(gameId, currentLive, "at_bat_out", {
          batter: prevLive.currentBatter || undefined,
          pitcher: currentLive.currentPitcher || undefined,
        }));
      }
    }
  }

  return {
    events,
    nextState: { live: currentLive, boxScore: currentBoxScore, seq: seqCounter },
  };
}
