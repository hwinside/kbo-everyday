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
  const finalSinceRef = useRef<number | null>(null);

  // Max 10 min of polling after final (in case KBO never fills boxScore, e.g. preseason)
  const FINAL_MAX_POLL_MS = 10 * 60 * 1000;

  const fetchDetail = useCallback(async () => {
    if (!gameId || stoppedRef.current) return;
    try {
      const res = await fetch(`/api/game-detail?gameId=${encodeURIComponent(gameId)}`);
      const json = await res.json();
      setData(json as GameDetailResponse);
      setError(json.error || null);

      const isFinalOrCancelled = json.status === "final" || json.status === "cancelled";
      const hasRealBox = json.boxScore &&
        (json.boxScore.awayBatters?.length > 0 || json.boxScore.homeBatters?.length > 0);

      if (isFinalOrCancelled) {
        if (hasRealBox) {
          // Got real data — stop immediately
          stoppedRef.current = true;
        } else {
          // Final but no boxScore — keep polling up to FINAL_MAX_POLL_MS
          if (!finalSinceRef.current) {
            finalSinceRef.current = Date.now();
          } else if (Date.now() - finalSinceRef.current > FINAL_MAX_POLL_MS) {
            stoppedRef.current = true;
          }
        }
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
