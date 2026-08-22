"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { resolveGameLiveDate } from "@/lib/game-live-date";
import { useVisibilityAwareInterval } from "@/lib/hooks/useVisibilityAwareInterval";
import { shouldCommitResponse, type SourceSnapshot } from "@/lib/source-snapshot";

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

export interface LiveGameSnapshot extends SourceSnapshot {
  source: string;
  stage: string;
}

type LiveGamePayload = {
  games?: LiveGameData[];
  error?: string;
  trace?: {
    source?: string;
    stage?: string;
    sourceAtMs?: number;
    fetchedAtMs?: number;
  };
};

export function useLiveGame(gameId?: string, pollInterval = 30000) {
  const [games, setGames] = useState<LiveGameData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LiveGameSnapshot | null>(null);
  const gameDate = resolveGameLiveDate(gameId);
  const requestGenerationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fetchCurrentGenerationRef = useRef<() => Promise<void>>(async () => {});
  const inFlightRef = useRef<Promise<void> | null>(null);
  const flightTokenRef = useRef<symbol | null>(null);
  const refreshQueuedRef = useRef(false);
  const mountedRef = useRef(true);
  const responseGenerationRef = useRef(0);

  const commitPayloadRef = useRef<(payload: LiveGamePayload, responseGeneration: number) => void>(
    () => {},
  );

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
    responseGenerationRef.current++;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    inFlightRef.current = null;
    flightTokenRef.current = null;
    refreshQueuedRef.current = false;
  }, [gameDate]);

  useEffect(() => {
    const generation = requestGenerationRef.current;
    commitPayloadRef.current = (payload, responseGeneration) => {
      if (
        !mountedRef.current
        || generation !== requestGenerationRef.current
        || !shouldCommitResponse(responseGenerationRef.current, responseGeneration)
      ) return;
      const trace = payload.trace;
      if (
        Array.isArray(payload.games)
        && trace
        && Number.isFinite(trace.sourceAtMs)
        && Number.isFinite(trace.fetchedAtMs)
      ) {
        setGames(payload.games);
        setSnapshot({
          generation: responseGeneration,
          source: trace.source || "unknown",
          stage: trace.stage || "unknown",
          sourceAtMs: trace.sourceAtMs!,
          fetchedAtMs: trace.fetchedAtMs!,
        });
        setError(null);
      } else {
        setError(payload.error || "invalid_live_payload");
      }
    };
    fetchCurrentGenerationRef.current = async () => {
      const responseGeneration = ++responseGenerationRef.current;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        const res = await fetch(`/api/game-live?date=${gameDate}`, {
          signal: controller.signal,
        });
        const data = await res.json() as LiveGamePayload;
        commitPayloadRef.current(
          res.ok ? data : { ...data, error: data.error || `HTTP ${res.status}` },
          responseGeneration,
        );
      } catch (e: unknown) {
        if (
          mountedRef.current
          && generation === requestGenerationRef.current
          && shouldCommitResponse(responseGenerationRef.current, responseGeneration)
          && (e as Error).name !== "AbortError"
        ) {
          setError((e as Error).message);
        }
      } finally {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        if (
          mountedRef.current
          && generation === requestGenerationRef.current
          && shouldCommitResponse(responseGenerationRef.current, responseGeneration)
        ) {
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

  const ingestExternal = useCallback((payload: unknown): void => {
    const responseGeneration = ++responseGenerationRef.current;
    commitPayloadRef.current((payload ?? {}) as LiveGamePayload, responseGeneration);
    if (
      mountedRef.current
      && shouldCommitResponse(responseGenerationRef.current, responseGeneration)
    ) {
      setLoading(false);
    }
  }, []);

  return { games, game, liveGames, loading, error, snapshot, refetch: fetchGames, ingestExternal };
}
