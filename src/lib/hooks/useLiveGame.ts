"use client";

import { useState, useEffect, useCallback } from "react";
import { resolveGameLiveDate } from "@/lib/game-live-date";
import { useVisibilityAwareInterval } from "@/lib/hooks/useVisibilityAwareInterval";

export interface LiveGameData {
  gameId: string;
  awayName: string;
  homeName: string;
  awayScore: number;
  homeScore: number;
  inning: number;
  isTop: boolean;
  balls: number;
  strikes: number;
  outs: number;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  runner1bOrder?: number;
  runner2bOrder?: number;
  runner3bOrder?: number;
  runner1bName: string | null;
  runner2bName: string | null;
  runner3bName: string | null;
  currentBatter: string | null;
  currentPitcher: string | null;
  currentInning: string;
  stadium: string;
  status?: "scheduled" | "live" | "final" | "cancelled";
  isLive: boolean;
  time?: string;
  awayStarterName: string | null;
  homeStarterName: string | null;
}

export function useLiveGame(gameId?: string, pollInterval = 30000) {
  const [games, setGames] = useState<LiveGameData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const gameDate = resolveGameLiveDate(gameId);

  const fetchGames = useCallback(async () => {
    try {
      const res = await fetch(`/api/game-live?date=${gameDate}`);
      const data = await res.json();
      if (data.games) setGames(data.games);
      setError(data.error || null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [gameDate]);

  // pollInterval<=0 이면 폴링 비활성 (비경기시간 등) — loading만 해제.
  useEffect(() => {
    if (pollInterval <= 0) setLoading(false);
  }, [pollInterval]);

  // 백그라운드 탭은 폴링 정지, 복귀 시 즉시 1회 갱신(보는 유저 실시간성 유지).
  // fetchGames는 Promise 반환이라 공용 훅 single-flight fence가 겹침을 막는다.
  // gameDate 전환 시 즉시 갱신. pollInterval<=0이면 enabled:false로 폴링 안 함.
  useVisibilityAwareInterval(fetchGames, pollInterval > 0 ? pollInterval : 30000, {
    enabled: pollInterval > 0,
    resetKey: gameDate,
  });

  const game = gameId ? games.find(g => g.gameId === gameId) : undefined;
  const liveGames = games.filter(g => g.isLive);

  return { games, game, liveGames, loading, error, refetch: fetchGames };
}
