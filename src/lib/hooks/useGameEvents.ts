"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { GameEvent, GameSnapshot } from "@/types/game-events";

interface UseGameEventsReturn {
  events: GameEvent[];
  currentState: GameSnapshot | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Poll /api/game-events every `pollInterval` ms when `enabled` is true.
 * Accumulates events client-side and dedupes by event id.
 */
export function useGameEvents(
  gameId: string | undefined,
  enabled: boolean,
  pollInterval = 15000,
): UseGameEventsReturn {
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [currentState, setCurrentState] = useState<GameSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seenIds = useRef(new Set<string>());

  const fetchEvents = useCallback(async () => {
    if (!gameId) return;
    try {
      const res = await fetch(`/api/game-events?gameId=${encodeURIComponent(gameId)}`);
      const data = await res.json();

      if (data.events) {
        const allEvents = data.events as GameEvent[];
        // Dedupe: only add events we haven't seen
        const newEvents: GameEvent[] = [];
        for (const e of allEvents) {
          if (!seenIds.current.has(e.id)) {
            seenIds.current.add(e.id);
            newEvents.push(e);
          }
        }
        if (newEvents.length > 0) {
          setEvents(prev => [...prev, ...newEvents]);
        }
      }

      if (data.currentState) {
        setCurrentState(data.currentState as GameSnapshot);
      }

      setError(data.error || null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [gameId]);

  useEffect(() => {
    if (!enabled || !gameId) {
      setIsLoading(false);
      return;
    }

    // Reset on gameId change
    seenIds.current.clear();
    setEvents([]);
    setCurrentState(null);
    setIsLoading(true);

    fetchEvents();
    const interval = setInterval(fetchEvents, pollInterval);
    return () => clearInterval(interval);
  }, [enabled, gameId, fetchEvents, pollInterval]);

  return { events, currentState, isLoading, error };
}
