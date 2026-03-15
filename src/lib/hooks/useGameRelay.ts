"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { GameRelayResponse } from "@/app/api/game-relay/route";

export type { GameRelayResponse, InningRelay, PlayEvent } from "@/app/api/game-relay/route";

export function useGameRelay(
  gameId: string | undefined,
  isLive: boolean,
  interval = 30000,
) {
  const [data, setData] = useState<GameRelayResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);

  const fetchRelay = useCallback(async () => {
    if (!gameId || !isLive) return;
    setIsLoading(true);
    try {
      const res = await fetch(
        `/api/game-relay?gameId=${encodeURIComponent(gameId)}`
      );
      if (res.ok && mountedRef.current) {
        const json = (await res.json()) as GameRelayResponse;
        setData(json);
      }
    } catch {
      // Silently fail — UI shows fallback
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [gameId, isLive]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isLive) {
      setData(null);
      return;
    }

    fetchRelay();
    const timer = setInterval(fetchRelay, interval);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [fetchRelay, interval, isLive]);

  return { data, isLoading };
}
