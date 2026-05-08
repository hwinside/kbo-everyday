/**
 * Event Generator — Diff engine for Phase 1 문자중계
 *
 * Compares previous vs current game state (LiveGameData + BoxScore)
 * to detect changes and generate GameEvent[].
 */

import type { GameEvent, GameEventType, EventDetail, GameSnapshot } from "@/types/game-events";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import type { BatterRecord, GameDetailResponse } from "@/app/api/game-detail/route";
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

/**
 * Per-batter stat diff (curr - prev). Lets us attribute events to the SPECIFIC
 * batter whose box-score line changed, instead of guessing from currentBatter
 * — which lags BoxScore on the wire and used to mis-attribute the previous
 * batter's walk to the next batter who'd just stepped in.
 */
interface BatterStatDiff {
  hits: number;
  hr: number;
  h2b: number;
  h3b: number;
  bb: number;
  so: number;
}

/** Diff prev vs curr batter rows by name; only batters with any change appear. */
function diffBatters(
  prev: readonly BatterRecord[] | undefined,
  curr: readonly BatterRecord[] | undefined,
): Map<string, BatterStatDiff> {
  const result = new Map<string, BatterStatDiff>();
  if (!curr) return result;
  const prevMap = new Map<string, BatterRecord>();
  for (const b of prev ?? []) prevMap.set(b.name, b);
  for (const c of curr) {
    const p = prevMap.get(c.name);
    const diff: BatterStatDiff = {
      hits: c.hits - (p?.hits ?? 0),
      hr: c.hr - (p?.hr ?? 0),
      h2b: c.h2b - (p?.h2b ?? 0),
      h3b: c.h3b - (p?.h3b ?? 0),
      bb: c.bb - (p?.bb ?? 0),
      so: c.so - (p?.so ?? 0),
    };
    if (diff.hits || diff.hr || diff.h2b || diff.h3b || diff.bb || diff.so) {
      result.set(c.name, diff);
    }
  }
  return result;
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
  // Hydrate the module-level seqCounter from the shared `prev.seq` so a
  // freshly-spawned serverless instance picks up where the previous one
  // left off. Without this, two instances both starting at 0 would mint
  // overlapping eventIds (e.g. `8-1`, `8-3`) and the client `seenRef`
  // dedupe would either skip real events or accept duplicates.
  if (prev && typeof prev.seq === "number") {
    seqCounter = Math.max(seqCounter, prev.seq);
  }

  const events: GameEvent[] = [];

  // [DEBUG strikeout-diff] entry trace — remove after diagnosis
  const sumSO = (rows: readonly BatterRecord[] | undefined) =>
    (rows ?? []).reduce((a, r) => a + (r.so || 0), 0);
  console.log("[event-gen entry]", JSON.stringify({
    gameId,
    hasPrev: !!prev,
    hasPrevBox: !!prev?.boxScore,
    prevInning: prev ? `${prev.live.inning}${prev.live.isTop ? "T" : "B"}` : null,
    prevOuts: prev?.live.outs,
    currInning: `${currentLive.inning}${currentLive.isTop ? "T" : "B"}`,
    currOuts: currentLive.outs,
    isLive: currentLive.isLive,
    prevAwaySO: sumSO(prev?.boxScore?.awayBatters),
    currAwaySO: sumSO(currentBoxScore?.awayBatters),
    prevHomeSO: sumSO(prev?.boxScore?.homeBatters),
    currHomeSO: sumSO(currentBoxScore?.homeBatters),
    currAwayBatterCount: currentBoxScore?.awayBatters?.length ?? 0,
    currHomeBatterCount: currentBoxScore?.homeBatters?.length ?? 0,
  }));

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
  // Per-batter diff: attribute events to the actual batter whose stat line moved,
  // not to currentBatter (which lags BoxScore and caused mis-attribution).
  if (currentBoxScore && prev.boxScore) {
    // When inning crossed between polls, a lag-delivered BoxScore update may
    // belong to the *previous* half-inning's batting side. We process both
    // halves so the lag event still lands on the correct batter with the
    // right inning/isTop attribution. Otherwise (steady inning) just the
    // current batting side.
    const sidesToProcess: Array<{ live: LiveGameData; isTop: boolean }> = [
      { live: currentLive, isTop: currentLive.isTop },
    ];
    if (prevInningKey !== currInningKey && prevLive.isTop !== currentLive.isTop) {
      sidesToProcess.unshift({ live: prevLive, isTop: prevLive.isTop });
    }

    for (const { live, isTop } of sidesToProcess) {
      const prevBatters = isTop ? prev.boxScore.awayBatters : prev.boxScore.homeBatters;
      const currBatters = isTop ? currentBoxScore.awayBatters : currentBoxScore.homeBatters;
      const pitcherName = live.currentPitcher || undefined;
      const batterDiffs = diffBatters(prevBatters, currBatters);

      // [DEBUG strikeout-diff] per-side trace — remove after diagnosis
      console.log("[event-gen side]", JSON.stringify({
        gameId,
        side: isTop ? "away" : "home",
        prevBatterRows: (prevBatters ?? []).map(b => `${b.name}:so${b.so}h${b.hits}bb${b.bb}`),
        currBatterRows: (currBatters ?? []).map(b => `${b.name}:so${b.so}h${b.hits}bb${b.bb}`),
        diffEntries: Array.from(batterDiffs.entries()).map(
          ([n, d]) => `${n}:so${d.so}h${d.hits}bb${d.bb}hr${d.hr}h2${d.h2b}h3${d.h3b}`,
        ),
      }));

      for (const [batterName, diff] of batterDiffs) {
        // Order matters within a single batter: HR/3B/2B counted explicitly,
        // remaining hits => 1B (at_bat_hit).
        for (let i = 0; i < diff.hr; i++) {
          events.push(makeEvent(gameId, live, "at_bat_homerun", {
            batter: batterName, pitcher: pitcherName,
          }));
        }
        for (let i = 0; i < diff.h3b; i++) {
          events.push(makeEvent(gameId, live, "at_bat_triple", {
            batter: batterName, pitcher: pitcherName,
          }));
        }
        for (let i = 0; i < diff.h2b; i++) {
          events.push(makeEvent(gameId, live, "at_bat_double", {
            batter: batterName, pitcher: pitcherName,
          }));
        }
        const single = diff.hits - diff.hr - diff.h2b - diff.h3b;
        for (let i = 0; i < single; i++) {
          events.push(makeEvent(gameId, live, "at_bat_hit", {
            batter: batterName, pitcher: pitcherName,
          }));
        }
        for (let i = 0; i < diff.bb; i++) {
          events.push(makeEvent(gameId, live, "at_bat_walk", {
            batter: batterName, pitcher: pitcherName,
          }));
        }
        for (let i = 0; i < diff.so; i++) {
          events.push(makeEvent(gameId, live, "at_bat_strikeout", {
            batter: batterName, pitcher: pitcherName,
          }));
        }
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
