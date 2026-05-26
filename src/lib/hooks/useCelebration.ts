"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { GameEvent } from "@/types/game-events";
import type { CelebrationEvent, CelebrationEventType } from "@/components/game/CelebrationOverlay";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { trackCelebration } from "@/lib/admin/tracker";

interface UseCelebrationOptions {
  myTeamId: number | null;
  homeTeamId: number;
  awayTeamId: number;
}

/**
 * Only process events generated within this window. Prevents replay of
 * accumulated server events on page re-entry, but must be wide enough to
 * tolerate BoxScore polling lag (typically 7–15s, occasionally up to a minute
 * when scoring plays land between scrapes).
 */
const FRESHNESS_THRESHOLD_MS = 120_000;

/**
 * Module-level dedupe for trackCelebration calls. Survives across component
 * mount/unmount cycles and React StrictMode double-renders. Prevents the same
 * event_id from triggering duplicate telemetry beacons within a 5s window.
 */
const trackedEvents = new Map<string, number>();
const TRACK_DEDUPE_MS = 5_000;

function shouldTrack(eventId: string): boolean {
  const now = Date.now();
  // Lazy cleanup: remove entries older than TRACK_DEDUPE_MS
  if (trackedEvents.size > 200) {
    for (const [k, t] of trackedEvents) {
      if (now - t > TRACK_DEDUPE_MS) trackedEvents.delete(k);
    }
  }
  if (trackedEvents.has(eventId) && now - trackedEvents.get(eventId)! < TRACK_DEDUPE_MS) {
    return false;
  }
  trackedEvents.set(eventId, now);
  return true;
}

/**
 * Module-level dedupe for display enqueue. Separate from trackedEvents because
 * telemetry and display fire in the same processEvents call — sharing a Map
 * would block display on first fire. This Set survives remounts so the same
 * event_id won't re-display after component unmount/remount or PWA resume.
 */
const displayedEventIds = new Set<string>();

/**
 * On first page entry / PWA resume, the server can return a shared event
 * history that accumulated while this client was not watching. Those events
 * are useful for the text relay, but must not all replay as celebrations.
 */
const RESUME_GRACE_MS = 1_000;

/**
 * Initial-fetch baseline window. Both source paths (KBO BoxScore-diff at 10–30s
 * cadence; Naver relay at 5s cadence) take a few seconds to land their first
 * response, and the relay generator emits *all historical plays* in that first
 * response (one fetch returns the full game history). Without a window-based
 * baseline, whichever source arrives second would replay every accumulated
 * celebration the moment the page opens.
 *
 * Single-batch `hasPrimedSeenRef` baseline (the previous design) seeds only
 * the source that fired first; the second source's first batch then floods.
 * Time-based baseline covers both arrival orderings — trade-off is that
 * celebrations that *actually fire* within this 8s window are missed
 * (replaying the whole game's history is far worse).
 */
const INITIAL_BASELINE_MS = 8_000;

/** Look up kboId from player name + teamId */
function findKboId(name: string | undefined, teamId: number): string | undefined {
  if (!name) return undefined;
  const entry = (PLAYERS_ROSTER as { name: string; teamId: number; kboId: string }[])
    .find((p) => p.name === name && p.teamId === teamId);
  return entry?.kboId;
}

/** Map GameEventType → CelebrationEventType, null if not celebration-worthy */
function toCelebrationType(eventType: string): CelebrationEventType | null {
  switch (eventType) {
    case "at_bat_homerun": return "homerun";
    case "game_end": return "victory";
    case "at_bat_triple": return "triple";
    case "at_bat_double": return "double";
    case "at_bat_hit": return "hit";
    case "at_bat_walk": return "walk";
    case "at_bat_strikeout": return "strikeout";
    default: return null;
  }
}

export function useCelebration({ myTeamId, homeTeamId, awayTeamId }: UseCelebrationOptions) {
  const [celebration, setCelebration] = useState<CelebrationEvent | null>(null);
  const celebrationRef = useRef<CelebrationEvent | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<CelebrationEvent[]>([]);
  /** Baseline window: all events seen before this timestamp are registered
   *  but not fired. Set on first processEvents() call and on PWA resume. */
  const baselineUntilRef = useRef<number | null>(null);
  const suppressBeforeRef = useRef<number>(Number.POSITIVE_INFINITY);
  /** Track pitcher strikeout counts for "2K, 3K..." display */
  const pitcherKRef = useRef<Map<string, number>>(new Map());

  // Keep ref in sync so processEvents can read it without being a dependency
  useEffect(() => { celebrationRef.current = celebration; }, [celebration]);

  const setCelebrationSafe = useCallback((val: CelebrationEvent | null) => {
    setCelebration(val);
    celebrationRef.current = val;
  }, []);

  /** Process the next item in queue when current celebration ends */
  const showNext = useCallback(() => {
    setCelebrationSafe(null);
    // Slight delay before showing next queued event
    setTimeout(() => {
      const next = queueRef.current.shift();
      if (next) setCelebrationSafe(next);
    }, 300);
  }, [setCelebrationSafe]);

  useEffect(() => {
    const markResumeBoundary = () => {
      // Drop anything already queued/showing from the previous visible session.
      queueRef.current = [];
      setCelebrationSafe(null);
      // Next poll may include the whole shared history. Treat events whose
      // server timestamp predates this visible session as already seen.
      suppressBeforeRef.current = Date.now() + RESUME_GRACE_MS;
      // Re-arm baseline window: relay's first post-resume fetch will deliver
      // the entire game history again. 8s seeds those into seenRef as
      // baseline so only post-resume celebrations fire.
      baselineUntilRef.current = Date.now() + INITIAL_BASELINE_MS;
      // K labels should reflect celebrations actually seen in this session,
      // not hidden/background history.
      pitcherKRef.current.clear();
    };

    if (document.visibilityState === "visible") {
      markResumeBoundary();
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        markResumeBoundary();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [setCelebrationSafe]);

  /** Call on each gameEvents update to detect new celebration-worthy events */
  const processEvents = useCallback(
    (events: GameEvent[]) => {
      if (!myTeamId) return;

      const now = Date.now();
      const newCelebrations: CelebrationEvent[] = [];

      // Time-based baseline window: 8s after first call (and after PWA resume)
      // seed every observed event into seenRef without firing. This covers the
      // case where the two source paths (KBO BoxScore-diff and Naver relay)
      // land their first batch at different times — without the window, the
      // later-arriving source would replay the entire game history.
      if (baselineUntilRef.current === null) {
        baselineUntilRef.current = now + INITIAL_BASELINE_MS;
      }
      if (now < baselineUntilRef.current) {
        for (const ev of events) seenRef.current.add(ev.id);
        return;
      }

      for (const ev of events) {
        if (seenRef.current.has(ev.id)) continue;
        seenRef.current.add(ev.id);

        const eventTime = new Date(ev.timestamp).getTime();
        if (!Number.isFinite(eventTime)) continue;

        if (eventTime <= suppressBeforeRef.current) continue;

        // Skip stale events (e.g. accumulated server events replayed on re-entry)
        const eventAge = now - eventTime;
        if (eventAge > FRESHNESS_THRESHOLD_MS) continue;

        const celebType = toCelebrationType(ev.type);
        if (!celebType) continue;

        // Victory event: only celebrate when my team wins
        if (celebType === "victory") {
          const awayWon = ev.snapshot.awayScore > ev.snapshot.homeScore;
          const homeWon = ev.snapshot.homeScore > ev.snapshot.awayScore;
          const winningTeamId = awayWon ? awayTeamId : homeWon ? homeTeamId : null;
          if (winningTeamId !== myTeamId) continue;

          newCelebrations.push({
            id: ev.id,
            type: celebType,
            teamId: myTeamId,
          });
          continue;
        }

        // Offense events: batting team must be my team
        // Defense events (strikeout): pitching team must be my team
        const battingTeamId = ev.isTop ? awayTeamId : homeTeamId;
        const pitchingTeamId = ev.isTop ? homeTeamId : awayTeamId;

        const isOffense = celebType !== "strikeout";
        const relevantTeamId = isOffense ? battingTeamId : pitchingTeamId;
        if (relevantTeamId !== myTeamId) continue;

        // Build celebration event
        const playerName = isOffense ? ev.detail.batter : ev.detail.pitcher;
        const kboId = findKboId(playerName, relevantTeamId);

        let strikeoutCount: number | undefined;
        if (celebType === "strikeout" && ev.detail.pitcher) {
          const prev = pitcherKRef.current.get(ev.detail.pitcher) ?? 0;
          const next = prev + 1;
          pitcherKRef.current.set(ev.detail.pitcher, next);
          strikeoutCount = next;
        }

        newCelebrations.push({
          id: ev.id,
          type: celebType,
          teamId: myTeamId,
          playerName,
          kboId,
          strikeoutCount,
        });
      }

      if (newCelebrations.length === 0) return;

      // Log each celebration trigger with inning/eventId for mis-attribution traceability.
      // Module-level shouldTrack() deduplicates across component re-mounts and
      // React StrictMode double-renders within a 5s window.
      const eventById = new Map(events.map(e => [e.id, e]));
      const gameId = events[0]?.gameId;
      for (const c of newCelebrations) {
        if (!c.id || !shouldTrack(c.id)) continue;
        const ev = eventById.get(c.id);
        const evTimeMs = ev ? new Date(ev.timestamp).getTime() : undefined;
        trackCelebration(
          c.type,
          gameId || "",
          c.teamId,
          c.playerName,
          c.id,
          ev?.inning,
          ev?.isTop,
          ev?.source,
          Number.isFinite(evTimeMs) ? evTimeMs : undefined,
        );
      }

      // Filter out any celebrations already queued, showing, or previously
      // displayed. The module-level displayedEventIds survives across component
      // remounts and PWA resume, closing the display double-fire gap that
      // instance-level seenRef + queuedIds alone cannot cover.
      const queuedIds = new Set(queueRef.current.map(c => c.id));
      if (celebrationRef.current?.id) queuedIds.add(celebrationRef.current.id);
      const fresh = newCelebrations.filter(c => {
        if (!c.id) return true;
        if (queuedIds.has(c.id)) return false;
        if (displayedEventIds.has(c.id)) return false;
        displayedEventIds.add(c.id);
        return true;
      });
      if (fresh.length === 0) return;

      // If nothing showing, start first immediately
      if (!celebrationRef.current && queueRef.current.length === 0) {
        setCelebrationSafe(fresh.shift()!);
      }
      // Queue the rest
      queueRef.current.push(...fresh);
    },
    [myTeamId, homeTeamId, awayTeamId, setCelebrationSafe],
  );

  return { celebration, processEvents, dismiss: showNext };
}
