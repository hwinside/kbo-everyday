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

  // Max 30 min of polling after final (KBO can take time to fill boxScore, especially preseason)
  const FINAL_MAX_POLL_MS = 30 * 60 * 1000;

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

  // 앱 포커스 복귀 시 강제 refetch (폴링 중단 후에도 데이터 복구)
  useEffect(() => {
    const onFocus = () => {
      stoppedRef.current = false;
      finalSinceRef.current = null;
      fetchDetail();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") onFocus();
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [fetchDetail]);

  return { data, loading, error, refetch: fetchDetail };
}
