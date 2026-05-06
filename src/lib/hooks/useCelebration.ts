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

  /** Call on each gameEvents update to detect new celebration-worthy events */
  const processEvents = useCallback(
    (events: GameEvent[]) => {
      if (!myTeamId) return;

      const now = Date.now();
      const newCelebrations: CelebrationEvent[] = [];

      for (const ev of events) {
        if (seenRef.current.has(ev.id)) continue;
        seenRef.current.add(ev.id);

        // Skip stale events (e.g. accumulated server events replayed on re-entry)
        const eventAge = now - new Date(ev.timestamp).getTime();
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

      // Log each celebration trigger with inning/eventId for mis-attribution traceability
      const eventById = new Map(events.map(e => [e.id, e]));
      const gameId = events[0]?.gameId;
      for (const c of newCelebrations) {
        const ev = c.id ? eventById.get(c.id) : undefined;
        trackCelebration(
          c.type,
          gameId || "",
          c.teamId,
          c.playerName,
          c.id,
          ev?.inning,
          ev?.isTop,
        );
      }

      // If nothing showing, start first immediately
      if (!celebrationRef.current && queueRef.current.length === 0) {
        setCelebrationSafe(newCelebrations.shift()!);
      }
      // Queue the rest
      queueRef.current.push(...newCelebrations);
    },
    [myTeamId, homeTeamId, awayTeamId, setCelebrationSafe],
  );

  return { celebration, processEvents, dismiss: showNext };
}
