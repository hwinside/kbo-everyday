"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { GameRelayResponse, InningRelay } from "@/app/api/game-relay/route";
import { planFinalFetch, afterFinalFetch } from "@/lib/hooks/final-relay-fetch";
import { mergeDeltaInnings } from "@/lib/game/relay-delta";

// delta(증분) 폴링: 매 N번째 폴링마다 한 번은 full로 받아 지난 이닝의 드문 정정을 self-heal 한다.
const FULL_REFRESH_EVERY = 10;

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
  const inFlightPromiseRef = useRef<Promise<boolean> | null>(null);
  // 누적 이닝 병합 캐시(`${inning}-${half}` 키). delta 응답은 이 캐시 위에 병합한다.
  const inningsRef = useRef<Map<string, InningRelay>>(new Map());
  const pollCountRef = useRef(0);
  // 현재 활성 gameId. gameId 전환 직후 이전 경기의 in-flight 응답이 늦게 도착해
  // 새 경기 state 를 오염시키는 것을 막기 위해 setData 전 이 값과 비교한다(삼순 blocker ②).
  const activeGameIdRef = useRef<string | undefined>(gameId);

  const fetchRelay = useCallback((): Promise<boolean> => {
    if (!gameId) return Promise.resolve(false);
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return Promise.resolve(false);
    }
    if (inFlightRef.current) return Promise.resolve(false);
    const requestGameId = gameId;
    const request = (async () => {
      inFlightRef.current = true;
      setIsLoading(true);
      let succeeded = false;
      try {
        const cache = inningsRef.current;
        // full 조건: 보유한 이닝이 없거나(첫 로드) 주기적 self-heal 차례.
        const n = pollCountRef.current++;
        const wantFull = cache.size === 0 || n % FULL_REFRESH_EVERY === 0;

        const params = new URLSearchParams({ gameId });
        if (currentInning > 0) params.set("inning", String(currentInning));
        if (!wantFull) {
          // 보유한 최대 이닝 번호만 delta로 요청(서버가 since-1부터 내려줌).
          let maxInn = 0;
          for (const inn of cache.values()) if (inn.inning > maxInn) maxInn = inn.inning;
          if (maxInn > 0) params.set("since", String(maxInn));
        }

        const res = await fetch(`/api/game-relay?${params}`);
        // 응답 도착 시점에 gameId 가 이미 전환됐으면 이 응답은 이전 경기 것 → 버린다.
        if (res.ok && mountedRef.current && activeGameIdRef.current === requestGameId) {
          const json = (await res.json()) as GameRelayResponse;
          // innings만 병합(delta면 과거 이닝 유지, full이면 재구성), matchup/linescore/
          // currentInning 등 라이브 필드는 최신 응답 그대로 유지.
          const mergedInnings = mergeDeltaInnings(cache, json.innings, json.partial === true);
          const merged: GameRelayResponse = {
            ...json,
            innings: mergedInnings,
            partial: false,
          };
          setData(merged);
          succeeded = true;
        }
      } catch {
        // Silently fail — UI shows fallback
      } finally {
        inFlightRef.current = false;
        inFlightPromiseRef.current = null;
        if (mountedRef.current) setIsLoading(false);
      }
      return succeeded;
    })();
    inFlightPromiseRef.current = request;
    return request;
  }, [gameId, currentInning]);

  // gameId 전환 시 누적 이닝 캐시·폴링 카운터·표시 데이터를 초기화한다. 이것이 없으면
  // 새 경기 첫 폴링이 이전 경기의 캐시(size>0) 때문에 since 를 보내 이전 경기 이닝 위에
  // delta 를 병합한다(교차 오염). 선언 순서상 폴링 effect 보다 먼저 실행된다.
  useEffect(() => {
    activeGameIdRef.current = gameId;
    inningsRef.current = new Map();
    pollCountRef.current = 0;
    finalFetchedRef.current = false;
    setData(null);
  }, [gameId]);

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
      let cancelled = false;
      let finalFetchQueued = false;
      // 삼순 blocker 2: hidden 중 live→final 전환이면 첫 시도가 skip 되므로 finalFetched 를
      // 미리 고정하지 않는다. live 요청이 진행 중이면 완료 뒤 종료 스냅샷을 한 번 더 받는다.
      const fetchFinalRelay = async () => {
        const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
        if (
          finalFetchQueued
          || planFinalFetch({ finalFetched: finalFetchedRef.current, visible }) === "skip"
        ) return;
        finalFetchQueued = true;
        try {
          await inFlightPromiseRef.current;
          if (
            cancelled
            || (typeof document !== "undefined" && document.visibilityState === "hidden")
          ) return;
          const ok = await fetchRelay();
          finalFetchedRef.current = afterFinalFetch(finalFetchedRef.current, ok);
        } finally {
          finalFetchQueued = false;
        }
      };
      fetchFinalRelay();
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") fetchFinalRelay();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        cancelled = true;
        mountedRef.current = false;
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }

    return () => { mountedRef.current = false; };
  }, [fetchRelay, interval, isLive, isFinal]);

  return { data, isLoading };
}
