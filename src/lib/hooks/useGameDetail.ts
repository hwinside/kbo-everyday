"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { GameDetailResponse } from "@/app/api/game-detail/route";

export type { GameDetailResponse };
export type {
  LineupEntry,
  BatterRecord,
  PitcherRecord,
} from "@/app/api/game-detail/route";

export function useGameDetail(
  gameId: string | undefined,
  pollInterval = 30000,
) {
  const [data, setData] = useState<GameDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const stoppedRef = useRef(false);

  const fetchDetail = useCallback(async () => {
    if (!gameId || stoppedRef.current) return;
    try {
      const res = await fetch(`/api/game-detail?gameId=${encodeURIComponent(gameId)}`);
      const json = await res.json();
      setData(json as GameDetailResponse);
      setError(json.error || null);

      // Stop polling when game is final or cancelled
      if (json.status === "final" || json.status === "cancelled") {
        stoppedRef.current = true;
      }
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  useEffect(() => {
    stoppedRef.current = false;
    setLoading(true);
    fetchDetail();

    const interval = setInterval(() => {
      if (!stoppedRef.current) fetchDetail();
    }, pollInterval);

    return () => clearInterval(interval);
  }, [fetchDetail, pollInterval]);

  return { data, loading, error, refetch: fetchDetail };
}
