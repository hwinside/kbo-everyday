/**
 * Event Generator — Diff engine for Phase 1 문자중계
 *
 * Compares previous vs current game state (LiveGameData + BoxScore)
 * to detect changes and generate GameEvent[].
 *
 * Event ids are deterministic semantic keys — `${gameId}-${type}-${key}` —
 * so two pollers (or two Vercel instances) seeing the same plate appearance
 * mint the same id and the atomic upsert RPC dedupes them by id. The
 * monotonically-increasing seq counter that the previous Option-W draft
 * relied on was instance-local; under the shared-store + last-write-wins
 * prev_state combination it let race-window concurrent polls each emit a
 * fresh id for the same logical event, accumulating hundreds of duplicate
 * `🔵 이주형 안타!` rows on KTWO0 8회말 (2026-05-09 incident).
 *
 * Extra-base hit counting uses MONOTONIC XBH clamping: effectiveXBH =
 * max(prev, curr) for HR/H2B/H3B. If a source-switch (KBO/Naver) delivers
 * a snapshot with stale XBH counts, the derived singles count (hits -
 * effectiveXBH) absorbs the regression without inflating. Singles emission
 * is also suppressed entirely when XBH regression is detected, to guard
 * against a concurrent hits bump being the uncategorized XBH itself
 * (6 false-positive at_bat_hit events across 3 games on 2026-05-17).
 */
import type { GameEvent, GameEventType, EventDetail, GameSnapshot } from "@/types/game-events";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import type { BatterRecord, GameDetailResponse } from "@/app/api/game-detail/route";
import { buildEventText } from "@/lib/event-text-builder";
import { normalizeBatterName } from "@/lib/relay-event-generator";

export interface PrevGameState {
  live: LiveGameData;
  boxScore: GameDetailResponse["boxScore"];
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
  dedupeKey: string,
): GameEvent {
  const snapshot = makeSnapshot(live);
  const event: GameEvent = {
    id: `${gameId}-${type}-${dedupeKey}`,
    gameId,
    timestamp: new Date().toISOString(),
    inning: live.inning,
    isTop: live.isTop,
    type,
    detail,
    text: "", // filled below
    snapshot,
    source: "kbo_diff",
  };
  event.text = buildEventText(event);
  return event;
}

function inningKey(inning: number, isTop: boolean): string {
  return `${inning}-${isTop ? "T" : "B"}`;
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

interface BatterDiffEntry {
  prev: BatterRecord | null;
  curr: BatterRecord;
  diff: BatterStatDiff;
}

/** Diff prev vs curr batter rows by name; only batters with any change appear. */
function diffBatters(
  prev: readonly BatterRecord[] | undefined,
  curr: readonly BatterRecord[] | undefined,
): Map<string, BatterDiffEntry> {
  const result = new Map<string, BatterDiffEntry>();
  if (!curr) return result;
  const prevMap = new Map<string, BatterRecord>();
  for (const b of prev ?? []) prevMap.set(b.name, b);
  for (const c of curr) {
    const p = prevMap.get(c.name) ?? null;
    const diff: BatterStatDiff = {
      hits: c.hits - (p?.hits ?? 0),
      hr: c.hr - (p?.hr ?? 0),
      h2b: c.h2b - (p?.h2b ?? 0),
      h3b: c.h3b - (p?.h3b ?? 0),
      bb: c.bb - (p?.bb ?? 0),
      so: c.so - (p?.so ?? 0),
    };
    if (diff.hits || diff.hr || diff.h2b || diff.h3b || diff.bb || diff.so) {
      result.set(c.name, { prev: p, curr: c, diff });
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
  const events: GameEvent[] = [];

  // First poll — no prev state, emit game_start if live
  if (!prev) {
    if (currentLive.isLive) {
      events.push(makeEvent(gameId, currentLive, "game_start", {}, "start"));
      events.push(makeEvent(gameId, currentLive, "inning_start", {
        inning: currentLive.inning,
        isTop: currentLive.isTop,
      }, inningKey(currentLive.inning, currentLive.isTop)));
    }
    return {
      events,
      nextState: { live: currentLive, boxScore: currentBoxScore },
    };
  }

  const prevLive = prev.live;

  // --- Game state transitions ---

  // Game just started
  if (!prevLive.isLive && currentLive.isLive) {
    events.push(makeEvent(gameId, currentLive, "game_start", {}, "start"));
  }

  // Game just ended
  if (prevLive.isLive && !currentLive.isLive && currentLive.awayScore + currentLive.homeScore > 0) {
    events.push(makeEvent(gameId, currentLive, "game_end", {}, "end"));
    return {
      events,
      nextState: { live: currentLive, boxScore: currentBoxScore },
    };
  }

  // --- Inning change ---
  const prevInningKey = inningKey(prevLive.inning, prevLive.isTop);
  const currInningKey = inningKey(currentLive.inning, currentLive.isTop);

  if (prevInningKey !== currInningKey && currentLive.isLive) {
    // Previous inning ended
    events.push(makeEvent(gameId, prevLive, "inning_end", {
      inning: prevLive.inning,
      isTop: prevLive.isTop,
    }, prevInningKey));
    // New inning started
    events.push(makeEvent(gameId, currentLive, "inning_start", {
      inning: currentLive.inning,
      isTop: currentLive.isTop,
    }, currInningKey));
  }

  // --- Post-game guard ---
  // game_end early-return (above) only fires on the live→not-live transition.
  // Subsequent polls where BOTH prev and curr are not-live would fall through
  // to BoxScore diffs, emitting ghost events from late-arriving stat corrections.
  // Guard: if the game is no longer live, skip all remaining event generation.
  if (!currentLive.isLive) {
    return {
      events,
      nextState: { live: currentLive, boxScore: currentBoxScore },
    };
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
    }, `${prevLive.currentPitcher}->${currentLive.currentPitcher}-${currInningKey}`));
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
      const sideKey = inningKey(live.inning, isTop);

      for (const [batterName, entry] of batterDiffs) {
        // dedupe-key encoding uses the whitespace-normalized name so the relay
        // path (relay-event-generator.ts) mints an identical id for the same
        // plate appearance, even when KBO BoxScore and Naver relay disagree on
        // whitespace (외국인 선수: "엘리엇 어슨" / "엘리엇어슨"). Displayed text
        // continues to use the raw KBO name (passed via detail.batter below).
        const batterNorm = normalizeBatterName(batterName);
        const { prev: bPrev, curr: bCurr } = entry;
        const prevHr = bPrev?.hr ?? 0;
        const prevH3b = bPrev?.h3b ?? 0;
        const prevH2b = bPrev?.h2b ?? 0;
        const prevHits = bPrev?.hits ?? 0;
        const prevBb = bPrev?.bb ?? 0;
        const prevSo = bPrev?.so ?? 0;

        // KBO BoxScore is occasionally lag-inconsistent across polls: an
        // extra-base hit (2B/3B/HR) lands in the per-at-bat cells *before*
        // the `hits` aggregate increments. The earlier poll observes
        // `hits=0, hr=1` (intermediate, inconsistent); the later poll
        // observes `hits=1, hr=1` (stable). A naive `diff.hits - diff.xbh`
        // 1B count then mints a bogus `at_bat_hit-...-0` 세레머니 right
        // after the real HR/2B/3B event (16 occurrences across 4 games on
        // 2026-05-16) — or, after a naive lag-skip guard, a bogus
        // `at_bat_hit-...-1` on the *next* poll because nextState retains
        // the inconsistent snapshot.
        //
        // Fix: drive singles off CUMULATIVE derived counts on both sides
        // of the diff. `singlesAt(state) = max(0, hits - hr - h2b - h3b)`
        // clamps the inconsistent intermediate state to 0; the lag delta
        // is absorbed naturally without needing to skip or rewrite
        // nextState. Extra-base / walk / strikeout stats are already
        // monotonic-by-construction, so cumulative max(0, curr-prev) on
        // them is just defense-in-depth against upstream stat corrections.
        // Monotonic XBH: extra-base hit counts should never decrease
        // between polls. If curr < prev, a source-switch (KBO↔Naver)
        // delivered a snapshot with stale XBH counts. Using max(prev,
        // curr) prevents regression from inflating the derived singles
        // count — closes the at_bat_hit-...-1 false-positive class
        // (6 occurrences across 3 games on 2026-05-17) that PR #88's
        // self-consistency clamp couldn't reach.
        const xbhRegressed =
          bCurr.hr < prevHr || bCurr.h3b < prevH3b || bCurr.h2b < prevH2b;
        if (xbhRegressed) {
          console.warn(
            `[event-gen] XBH regression for ${batterName} in ${gameId}: ` +
            `prev(hr=${prevHr},h3b=${prevH3b},h2b=${prevH2b}) → ` +
            `curr(hr=${bCurr.hr},h3b=${bCurr.h3b},h2b=${bCurr.h2b}) — skipping singles`,
          );
        }
        const effectiveHr = Math.max(prevHr, bCurr.hr);
        const effectiveH3b = Math.max(prevH3b, bCurr.h3b);
        const effectiveH2b = Math.max(prevH2b, bCurr.h2b);

        const prevSingles = Math.max(0, prevHits - prevHr - prevH3b - prevH2b);
        const currSingles = Math.max(
          0,
          bCurr.hits - effectiveHr - effectiveH3b - effectiveH2b,
        );

        const hrDelta = Math.max(0, bCurr.hr - prevHr);
        const h3bDelta = Math.max(0, bCurr.h3b - prevH3b);
        const h2bDelta = Math.max(0, bCurr.h2b - prevH2b);
        // Skip singles during XBH regression: even with monotonic
        // effective counts, a concurrent hits bump could be the
        // uncategorized XBH itself. Recovery: next stable poll.
        const singleDelta = xbhRegressed
          ? 0
          : Math.max(0, currSingles - prevSingles);
        const bbDelta = Math.max(0, bCurr.bb - prevBb);
        const soDelta = Math.max(0, bCurr.so - prevSo);

        // Order matters within a single batter: HR/3B/2B counted explicitly,
        // remaining hits => 1B (at_bat_hit). dedupe key encodes the
        // 1-based cumulative occurrence index for this stat — same plate
        // appearance always lands on the same id regardless of polling
        // instance.
        for (let i = 0; i < hrDelta; i++) {
          const idx = prevHr + i + 1;
          events.push(makeEvent(gameId, live, "at_bat_homerun", {
            batter: batterName, pitcher: pitcherName,
          }, `${sideKey}-${batterNorm}-${idx}`));
        }
        for (let i = 0; i < h3bDelta; i++) {
          const idx = prevH3b + i + 1;
          events.push(makeEvent(gameId, live, "at_bat_triple", {
            batter: batterName, pitcher: pitcherName,
          }, `${sideKey}-${batterNorm}-${idx}`));
        }
        for (let i = 0; i < h2bDelta; i++) {
          const idx = prevH2b + i + 1;
          events.push(makeEvent(gameId, live, "at_bat_double", {
            batter: batterName, pitcher: pitcherName,
          }, `${sideKey}-${batterNorm}-${idx}`));
        }
        for (let i = 0; i < singleDelta; i++) {
          const idx = prevSingles + i + 1;
          events.push(makeEvent(gameId, live, "at_bat_hit", {
            batter: batterName, pitcher: pitcherName,
          }, `${sideKey}-${batterNorm}-${idx}`));
        }
        for (let i = 0; i < bbDelta; i++) {
          const idx = prevBb + i + 1;
          events.push(makeEvent(gameId, live, "at_bat_walk", {
            batter: batterName, pitcher: pitcherName,
          }, `${sideKey}-${batterNorm}-${idx}`));
        }
        for (let i = 0; i < soDelta; i++) {
          const idx = prevSo + i + 1;
          events.push(makeEvent(gameId, live, "at_bat_strikeout", {
            batter: batterName, pitcher: pitcherName,
          }, `${sideKey}-${batterNorm}-${idx}`));
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
        }, `${oldPitcher}->${newPitcher}-${currInningKey}`));
      }
    }
  }

  // --- Score change ---
  // Score is monotonic per game so the (away,home) pair is itself a stable
  // dedupe key — two instances seeing the same KBO snapshot mint the same id.
  const awayDiff = currentLive.awayScore - prevLive.awayScore;
  const homeDiff = currentLive.homeScore - prevLive.homeScore;
  const totalScoreDiff = awayDiff + homeDiff;

  if (totalScoreDiff > 0) {
    const hrEvents = events.filter(e => e.type === "at_bat_homerun").length;
    const runsToReport = totalScoreDiff - hrEvents;
    if (runsToReport > 0) {
      events.push(makeEvent(gameId, currentLive, "run_scored", {
        rbi: runsToReport,
      }, `${currentLive.awayScore}-${currentLive.homeScore}`));
    }
  }

  // --- Out count change (inferred) ---
  if (prevInningKey === currInningKey) {
    const outDiff = currentLive.outs - prevLive.outs;
    if (outDiff > 0) {
      const soEvents = events.filter(e => e.type === "at_bat_strikeout").length;
      const outsToReport = outDiff - soEvents;
      for (let i = 0; i < outsToReport; i++) {
        const idx = prevLive.outs + soEvents + i + 1;
        events.push(makeEvent(gameId, currentLive, "at_bat_out", {
          batter: prevLive.currentBatter || undefined,
          pitcher: currentLive.currentPitcher || undefined,
        }, `${currInningKey}-${idx}`));
      }
    }
  }

  return {
    events,
    nextState: { live: currentLive, boxScore: currentBoxScore },
  };
}
