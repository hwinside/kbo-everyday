"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  const requestGenerationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fetchCurrentGenerationRef = useRef<() => Promise<void>>(async () => {});
  const inFlightRef = useRef<Promise<void> | null>(null);
  const flightTokenRef = useRef<symbol | null>(null);
  const refreshQueuedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      inFlightRef.current = null;
      flightTokenRef.current = null;
      refreshQueuedRef.current = false;
    };
  }, []);

  // 날짜가 바뀌면 이전 요청을 즉시 폐기하고 새 세대가 독립적으로 시작되게 한다.
  // Abort를 무시하는 fetch 구현도 generation fence를 통과할 수 없다.
  useEffect(() => {
    requestGenerationRef.current++;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    inFlightRef.current = null;
    flightTokenRef.current = null;
    refreshQueuedRef.current = false;
  }, [gameDate]);

  useEffect(() => {
    const generation = requestGenerationRef.current;
    fetchCurrentGenerationRef.current = async () => {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        const res = await fetch(`/api/game-live?date=${gameDate}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (!mountedRef.current || generation !== requestGenerationRef.current) return;
        if (data.games) setGames(data.games);
        setError(data.error || null);
      } catch (e: unknown) {
        if (
          mountedRef.current
          && generation === requestGenerationRef.current
          && (e as Error).name !== "AbortError"
        ) {
          setError((e as Error).message);
        }
      } finally {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        if (mountedRef.current && generation === requestGenerationRef.current) {
          setLoading(false);
        }
      }
    };
  }, [gameDate]);

  // poller와 공개 refetch가 같은 single-flight/queued-refresh 경로를 공유한다.
  // 진행 중 호출은 새 요청을 겹치지 않고, settle 직후 최신 요청 1회로 합쳐진다.
  const fetchGames = useCallback((): Promise<void> => {
    if (inFlightRef.current) {
      refreshQueuedRef.current = true;
      return inFlightRef.current;
    }

    const generation = requestGenerationRef.current;
    const flightToken = Symbol();
    const flight = (async () => {
      try {
        do {
          refreshQueuedRef.current = false;
          await fetchCurrentGenerationRef.current();
        } while (
          mountedRef.current
          && generation === requestGenerationRef.current
          && refreshQueuedRef.current
        );
      } finally {
        if (flightTokenRef.current === flightToken) {
          inFlightRef.current = null;
          flightTokenRef.current = null;
        }
      }
    })();
    flightTokenRef.current = flightToken;
    inFlightRef.current = flight;
    return flight;
  }, []);

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
