"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { GameRelayResponse } from "@/app/api/game-relay/route";
import { planFinalFetch, afterFinalFetch } from "@/lib/hooks/final-relay-fetch";

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
  const inFlightRef = useRef(false);

  const fetchRelay = useCallback(async (): Promise<boolean> => {
    if (!gameId) return false;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setIsLoading(true);
    let succeeded = false;
    try {
      const params = new URLSearchParams({ gameId });
      if (currentInning > 0) params.set("inning", String(currentInning));
      const res = await fetch(`/api/game-relay?${params}`);
      if (res.ok && mountedRef.current) {
        const json = (await res.json()) as GameRelayResponse;
        setData(json);
        succeeded = true;
      }
    } catch {
      // Silently fail — UI shows fallback
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setIsLoading(false);
    }
    return succeeded;
  }, [gameId, currentInning]);

  useEffect(() => {
    mountedRef.current = true;

    if (isLive) {
      finalFetchedRef.current = false;
      fetchRelay();
      const timer = setInterval(fetchRelay, interval);
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") fetchRelay();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        mountedRef.current = false;
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }

    if (isFinal) {
      // 삼순 blocker 2: hidden 중 live→final 전환이면 첫 시도가 skip 되므로 finalFetched 를
      // 미리 고정하지 않고(afterFinalFetch: 성공 때만 latch), visible 복귀 시 재시도한다.
      const fetchFinalRelay = async () => {
        const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
        if (planFinalFetch({ finalFetched: finalFetchedRef.current, visible }) === "skip") return;
        const ok = await fetchRelay();
        finalFetchedRef.current = afterFinalFetch(finalFetchedRef.current, ok);
      };
      fetchFinalRelay();
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") fetchFinalRelay();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        mountedRef.current = false;
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }

    return () => { mountedRef.current = false; };
  }, [fetchRelay, interval, isLive, isFinal]);

  return { data, isLoading };
}
