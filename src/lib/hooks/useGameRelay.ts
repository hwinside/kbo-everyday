"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { GameRelayResponse } from "@/app/api/game-relay/route";

export type { GameRelayResponse, InningRelay, PlayEvent, MatchupStats, RelayPlayerStats, RelayBatterStat, RelayPitcherStat } from "@/app/api/game-relay/route";

export function useGameRelay(
  gameId: string | undefined,
  isLive: boolean,
  interval = 30000,
  currentInning = 0,
  isFinal = false,
) {
  const [data, setData] = useState<GameRelayResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);
  const finalFetchedRef = useRef(false);

  const fetchRelay = useCallback(async () => {
    if (!gameId) return;
    setIsLoading(true);
    try {
      const params = new URLSearchParams({ gameId });
      if (currentInning > 0) params.set("inning", String(currentInning));
      const res = await fetch(`/api/game-relay?${params}`);
      if (res.ok && mountedRef.current) {
        const json = (await res.json()) as GameRelayResponse;
        setData(json);
      }
    } catch {
      // Silently fail — UI shows fallback
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [gameId, currentInning]);

  useEffect(() => {
    mountedRef.current = true;

    if (isLive) {
      finalFetchedRef.current = false;
      fetchRelay();
      const timer = setInterval(fetchRelay, interval);
      return () => {
        mountedRef.current = false;
        clearInterval(timer);
      };
    }

    // 종료 경기: 한 번만 fetch (relay 데이터로 스탯 탭 fallback)
    if (isFinal && !finalFetchedRef.current) {
      finalFetchedRef.current = true;
      fetchRelay();
    }

    return () => { mountedRef.current = false; };
  }, [fetchRelay, interval, isLive, isFinal]);

  return { data, isLoading };
}
