"use client";

import { useState, useEffect, useCallback } from "react";
import { resolveGameLiveDate } from "@/lib/game-live-date";

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

  useEffect(() => {
    // pollInterval=0 이면 폴링 비활성 (비경기시간 등)
    if (pollInterval <= 0) {
      setLoading(false);
      return;
    }
    fetchGames();
    const interval = setInterval(fetchGames, pollInterval);
    return () => clearInterval(interval);
  }, [fetchGames, pollInterval]);

  const game = gameId ? games.find(g => g.gameId === gameId) : undefined;
  const liveGames = games.filter(g => g.isLive);

  return { games, game, liveGames, loading, error, refetch: fetchGames };
}
