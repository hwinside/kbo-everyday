"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { GameEvent } from "@/types/game-events";
import type { CelebrationEvent, CelebrationEventType } from "@/components/game/CelebrationOverlay";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { trackCelebration } from "@/lib/admin/tracker";

interface UseCelebrationOptions {
  /** Current game id — when this changes the hook rebaselines all per-session
   *  state (seen ids, source-prime flags, K counts) so a new game's relay
   *  full-history batch doesn't replay celebrations from the previous game's
   *  primed `relay`/`kbo_diff` sources. The Next.js dynamic route
   *  `/games/[gameId]/page.tsx` keeps the same component instance across
   *  param changes; without this reset, SPA navigation between games leaks
   *  primed-source state forward. */
  gameId: string;
  myTeamId: number | null;
  homeTeamId: number;
  awayTeamId: number;
}

interface ProcessEventsOptions {
  /** visibility 복귀 직후 실제 live→final diff로 만든 종료 이벤트는 baseline/suppress 대상에서 제외. */
  preserveFreshGameEnd?: boolean;
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
 * Source-aware baseline contract. Each generator (`kbo_diff`, `relay`) emits a
 * *full history batch* on its first successful response, with `timestamp =
 * now` because neither source carries true play-occurrence timestamps. We
 * treat the FIRST batch from each source as baseline-only (seed into seenRef,
 * never fire), then process subsequent batches normally. This is independent
 * of wall-clock — if relay's first response lands 30s after page entry, that
 * first batch still seeds baseline rather than flooding historical
 * celebrations. Previous design relied on an 8s wall-clock window which let
 * any source whose first response arrived after 8s replay the entire history.
 *
 * Per-source tracking via primedSourcesRef. Reset on PWA resume so the next
 * source-first batches re-baseline.
 */

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

export function useCelebration({ gameId, myTeamId, homeTeamId, awayTeamId }: UseCelebrationOptions) {
  const [celebration, setCelebration] = useState<CelebrationEvent | null>(null);
  const celebrationRef = useRef<CelebrationEvent | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<CelebrationEvent[]>([]);
  /** Source-aware baseline: each unique `ev.source` value's FIRST batch seeds
   *  seenRef silently, subsequent batches are processed for celebration.
   *  Cleared on PWA resume so the next first-batch from each source rebaselines. */
  const primedSourcesRef = useRef<Set<string>>(new Set());
  const suppressBeforeRef = useRef<number>(Number.POSITIVE_INFINITY);
  /** Track pitcher strikeout counts for "2K, 3K..." display */
  const pitcherKRef = useRef<Map<string, number>>(new Map());

  // Keep ref in sync so processEvents can read it without being a dependency
  useEffect(() => { celebrationRef.current = celebration; }, [celebration]);

  const setCelebrationSafe = useCallback((val: CelebrationEvent | null) => {
    setCelebration(val);
    celebrationRef.current = val;
  }, []);

  // gameId-change reset. On initial mount this also runs but every ref is
  // already empty so the clear()s are no-ops. On subsequent gameId changes
  // (SPA navigation between game pages while the component instance is
  // reused) this rebaselines everything, so the new game's first relay
  // full-history batch is seeded into seenRef rather than fired as celebrations.
  //
  // setCelebration in effect is intentional here: if the previous game's
  // celebration overlay is still on screen at the moment of navigation, the
  // user is now looking at game B's data and the stale overlay must hide.
  // Ref-only reset would leave the old overlay rendered until the next
  // independent state update. This is a one-shot reset on a discrete external
  // signal (route param change), not a continuous derived-state computation.
  useEffect(() => {
    seenRef.current.clear();
    queueRef.current = [];
    primedSourcesRef.current.clear();
    pitcherKRef.current.clear();
    // suppressBefore MUST be a finite value matching the resume-boundary
    // semantics. Setting it to Infinity (the initial ref value) here would
    // make `eventTime <= suppressBeforeRef.current` true for every subsequent
    // event, silently blocking every celebration on the new game until the
    // next visibilitychange→visible fires markResumeBoundary. gameId change
    // is itself a session boundary, so reuse the same RESUME_GRACE_MS window.
    suppressBeforeRef.current = Date.now() + RESUME_GRACE_MS;
    celebrationRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCelebration(null);
  }, [gameId]);

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
      // Clear per-source baseline state — both `kbo_diff` and `relay` will
      // re-deliver their full history on the first post-resume fetch, and
      // those first batches must seed seenRef silently rather than fire.
      primedSourcesRef.current.clear();
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
    (events: GameEvent[], options?: ProcessEventsOptions) => {
      if (!myTeamId) return;

      const now = Date.now();
      const newCelebrations: CelebrationEvent[] = [];
      const shouldPreserve = (ev: GameEvent) =>
        options?.preserveFreshGameEnd === true
        && ev.type === "game_end"
        && ev.source === "kbo_diff";

      // Per-source baseline: the first batch from each unique ev.source seeds
      // seenRef silently. Subsequent batches process new ids normally.
      // Events lacking a source field (legacy/unknown) are bucketed under
      // "_unknown" so they also get a one-shot baseline rather than firing
      // on first observation.
      const sourcesInBatch = new Set<string>();
      for (const ev of events) {
        sourcesInBatch.add(ev.source ?? "_unknown");
      }
      const sourcesToBaseline: string[] = [];
      for (const src of sourcesInBatch) {
        if (!primedSourcesRef.current.has(src)) {
          sourcesToBaseline.push(src);
          primedSourcesRef.current.add(src);
        }
      }
      if (sourcesToBaseline.length > 0) {
        for (const ev of events) {
          if (sourcesToBaseline.includes(ev.source ?? "_unknown") && !shouldPreserve(ev)) {
            seenRef.current.add(ev.id);
          }
        }
        // Continue to process the OTHER sources' events in this batch (mixed
        // batches: an already-primed source's events still process for
        // celebration). The seenRef seeding above already filters out the
        // baseline source's events from the loop below via seenRef.has(ev.id).
      }

      for (const ev of events) {
        if (seenRef.current.has(ev.id)) continue;
        seenRef.current.add(ev.id);

        const eventTime = new Date(ev.timestamp).getTime();
        if (!Number.isFinite(eventTime)) continue;

        if (eventTime <= suppressBeforeRef.current && !shouldPreserve(ev)) continue;

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
