"use client";

import { useState, useEffect, useCallback } from "react";

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
  currentBatter: string | null;
  currentPitcher: string | null;
  currentInning: string;
  stadium: string;
  isLive: boolean;
}

export function useLiveGame(gameId?: string, pollInterval = 30000) {
  const [games, setGames] = useState<LiveGameData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchGames = useCallback(async () => {
    try {
      const res = await fetch("/api/game-live");
      const data = await res.json();
      if (data.games) setGames(data.games);
      setError(data.error || null);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGames();
    const interval = setInterval(fetchGames, pollInterval);
    return () => clearInterval(interval);
  }, [fetchGames, pollInterval]);

  const game = gameId ? games.find(g => g.gameId === gameId) : undefined;
  const liveGames = games.filter(g => g.isLive);

  return { games, game, liveGames, loading, error, refetch: fetchGames };
}
