"use client";

import { useState, useEffect, useCallback, useRef, type MutableRefObject } from "react";
import type { GameRelayResponse, InningRelay } from "@/app/api/game-relay/route";
import type { GameEvent } from "@/types/game-events";
import { planFinalFetch, afterFinalFetch } from "@/lib/hooks/final-relay-fetch";
import {
  mergeDeltaInnings,
  resolveDeltaSince,
  shouldApplyRelayResponse,
  shouldReleaseInFlight,
} from "@/lib/game/relay-delta";
import {
  consumeLivePollStream,
  shouldEmbedDetail,
  shouldEmbedLive,
  shouldCombineGameEvents,
  type LivePollEnvelope,
} from "@/lib/game/live-poll-stream";
import { resolveGameLiveDate } from "@/lib/game-live-date";

// delta(증분) 폴링: 매 N번째 폴링마다 한 번은 full로 받아 지난 이닝의 드문 정정을 self-heal 한다.
const FULL_REFRESH_EVERY = 10;
// 경기 시작(scheduled→live) 순간 모든 시청자의 폴링이 같은 tick으로 정렬돼
// cold 인스턴스 burst가 업스트림으로 증폭된다(2026-08-11 19:00 timeout 266건 실측).
// 서버 single-flight는 인스턴스 내 증폭만 막으므로, 시작점 bounded jitter로
// 인스턴스 간(cross-instance) 동시성까지 흩뿌린다(삼순 2차 리뷰 ①).
export const RELAY_POLL_MAX_JITTER_MS = 2000;

/**
 * live 폴링 시작점 bounded jitter 스케줄러 (훅 effect에서 분리한 순수 로직).
 *
 * 왜 분리했나(삼순 3차 ③): jitter 계약(0~min(interval, 2s)·초기 timer cleanup·
 * interval 1회 시작)을 React 렌더러 없이 fake timer/고정 random으로 prebuild
 * 게이트에 고정하기 위해. 훅은 이 함수를 그대로 사용한다(재구현 금지).
 */
export function scheduleJitteredRelayPolling(opts: {
  fetchRelay: () => unknown;
  interval: number;
  random?: () => number;
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (t: ReturnType<typeof setTimeout>) => void;
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (t: ReturnType<typeof setInterval>) => void;
}): { jitterMs: number; cleanup: () => void } {
  const {
    fetchRelay,
    interval,
    random = Math.random,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = opts;
  const jitterMs = random() * Math.min(interval, RELAY_POLL_MAX_JITTER_MS);
  let timer: ReturnType<typeof setInterval> | null = null;
  const jitterTimer = setTimeoutFn(() => {
    fetchRelay();
    timer = setIntervalFn(fetchRelay, interval);
  }, jitterMs);
  return {
    jitterMs,
    cleanup: () => {
      clearTimeoutFn(jitterTimer);
      if (timer) clearIntervalFn(timer);
    },
  };
}
const FINAL_EVENTS_TAIL_TIMEOUT_MS = 12_000;
interface GameEventsPayload {
  events?: GameEvent[];
  error?: string | null;
}

interface UseGameRelayOptions {
  onLiveFrame?: (data: unknown) => void;
  onDetailFrame?: (data: unknown) => void;
}

export type { GameRelayResponse, InningRelay, PlayEvent, MatchupStats, RelayPlayerStats, RelayBatterStat, RelayPitcherStat } from "@/app/api/game-relay/route";

export function useGameRelay(
  gameId: string | undefined,
  isLive: boolean,
  interval = 30000,
  currentInning = 0,
  isFinal = false,
  options?: UseGameRelayOptions,
) {
  const [data, setData] = useState<GameRelayResponse | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
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
  // 요청마다 발급하는 단조증가 seq. gameId 전환·후행 요청이 증가시켜, 늦게 끝난 이전 요청이
  // 공용 in-flight/promise/loading 을 clear 하거나 setData 하지 못하게 fencing 한다(삼순 blocker ②).
  const requestSeqRef = useRef(0);
  // 현재 in-flight 요청의 abort 핸들. gameId 전환 시 즉시 abort 해 B full 을 막힘없이 시작시킨다.
  // 통합 요청은 relay frame 전달 뒤 events frame을 계속 기다리는 동안 다음 relay poll이
  // 시작될 수 있으므로 controller를 Set으로 추적한다. gameId 전환 시 전부 abort한다.
  const abortControllersRef = useRef(new Set<AbortController>());
  const seenEventIdsRef = useRef(new Set<string>());
  const previousLiveGameIdRef = useRef<string | undefined>(undefined);
  const liveFrameOwnerSeqRef = useRef(0);
  const detailFrameOwnerSeqRef = useRef(0);

  const fetchRelay = useCallback((
    eventsTailTimeoutMs?: number,
    opts?: { forceEmbed?: boolean },
  ): Promise<boolean> => {
    if (!gameId) return Promise.resolve(false);
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return Promise.resolve(false);
    }
    if (inFlightRef.current) return Promise.resolve(false);
    const requestGameId = gameId;
    // 이 요청의 신분증. inFlight 가드 통과 후에만 증가시켜(중복 폴 조기 반환은 seq 미소모)
    // parse/finally 재확인의 기준으로 쓴다. gameId 전환·후행 요청이 이 값을 다시 올리면 stale 이 된다.
    const mySeq = ++requestSeqRef.current;
    const controller = new AbortController();
    abortControllersRef.current.add(controller);
    inFlightRef.current = true;
    setIsLoading(true);

    let settleRelay!: (ok: boolean) => void;
    let relaySettled = false;
    const relayResult = new Promise<boolean>((resolve) => {
      settleRelay = (ok) => {
        if (relaySettled) return;
        relaySettled = true;
        resolve(ok);
      };
    });
    inFlightPromiseRef.current = relayResult;

    const releaseRelaySlot = () => {
      if (!shouldReleaseInFlight(mySeq, requestSeqRef.current)) return;
      inFlightRef.current = false;
      inFlightPromiseRef.current = null;
      if (mountedRef.current) setIsLoading(false);
    };

    const request = (async (): Promise<boolean> => {
      let relaySucceeded = false;
      let eventsSucceeded = false;
      let eventsReceived = false;
      let eventsTailTimeout: ReturnType<typeof setTimeout> | null = null;
      const clearEventsTailTimeout = () => {
        if (eventsTailTimeout) clearTimeout(eventsTailTimeout);
        eventsTailTimeout = null;
      };
      const armEventsTailTimeout = () => {
        if (!eventsTailTimeoutMs || eventsReceived || eventsTailTimeout) return;
        eventsTailTimeout = setTimeout(() => controller.abort(), eventsTailTimeoutMs);
      };
      try {
        const cache = inningsRef.current;
        // full 조건: 보유한 이닝이 없거나(첫 로드) 주기적 self-heal 차례.
        const n = pollCountRef.current++;
        const wantFull = cache.size === 0 || n % FULL_REFRESH_EVERY === 0;
        // 첫 poll + 이후 기존 15초 cadence마다 events를 같은 Edge Request에 싣는다.
        // final 전환은 game_end/victory 발화를 위해 항상 events 포함.
        const wantEvents = shouldCombineGameEvents(n, isFinal);
        const forceEmbed = opts?.forceEmbed === true;
        const includeLive = isLive && (forceEmbed || shouldEmbedLive(n, interval));
        const includeDetail = isLive && (forceEmbed || shouldEmbedDetail(n, interval));
        const include: string[] = [];
        if (includeLive) include.push("live");
        if (includeDetail) include.push("detail");

        const params = new URLSearchParams({ gameId: requestGameId });
        if (currentInning > 0) params.set("inning", String(currentInning));
        if (include.length > 0) {
          params.set("include", include.join(","));
          params.set("date", resolveGameLiveDate(requestGameId));
        }
        // since 는 로컬 보유 이닝이 아니라 **공유 canonical 이닝**과 일치할 때만 보낸다.
        // 로컬 최대값을 그대로 보내면 클라이언트별로 쿼리가 갈라져 엣지 캐시 키가
        // 시청자 수만큼 폭발한다(캐시 적중 불가 → 절감 무효화). 상세 계약은
        // resolveDeltaSince 주석 참조.
        let localMaxInning = 0;
        for (const inn of cache.values()) {
          if (inn.inning > localMaxInning) localMaxInning = inn.inning;
        }
        const since = resolveDeltaSince({
          localMaxInning,
          canonicalInning: currentInning,
          wantFull,
        });
        if (since > 0) params.set("since", String(since));

        const applyRelay = (json: GameRelayResponse) => {
          // parse 후 재확인: gameId 가 headers 통과와 body 파싱 사이에 전환됐을 수 있다(late-body).
          // seq 일치 + 활성 gameId 일치 + 마운트 상태일 때만 setData(삼순 blocker ②).
          if (shouldApplyRelayResponse({
            mounted: mountedRef.current,
            requestSeq: mySeq,
            currentSeq: requestSeqRef.current,
            requestGameId,
            activeGameId: activeGameIdRef.current,
          })) {
            // innings만 병합(delta면 과거 이닝 유지, full이면 재구성), matchup/linescore/
            // currentInning 등 라이브 필드는 최신 응답 그대로 유지.
            const mergedInnings = mergeDeltaInnings(cache, json.innings, json.partial === true);
            const merged: GameRelayResponse = {
              ...json,
              innings: mergedInnings,
              partial: false,
            };
            setData(merged);
            relaySucceeded = true;
          }
          settleRelay(relaySucceeded);
          // 통합 stream의 events가 늦어져도 relay poll slot은 frame 도착 즉시 해제한다.
          releaseRelaySlot();
          // 서버 relay 정상 상한까지는 기다리고, relay frame 뒤 남은 events tail만 bound한다.
          armEventsTailTimeout();
        };

        const applyEvents = (envelope: LivePollEnvelope) => {
          eventsReceived = true;
          clearEventsTailTimeout();
          const payload = envelope.data as GameEventsPayload;
          if (
            !mountedRef.current
            || activeGameIdRef.current !== requestGameId
          ) return;

          if (payload.events) {
            const newEvents: GameEvent[] = [];
            for (const event of payload.events) {
              if (seenEventIdsRef.current.has(event.id)) continue;
              seenEventIdsRef.current.add(event.id);
              newEvents.push(event);
            }
            if (newEvents.length > 0) {
              setEvents((previous) => [...previous, ...newEvents]);
            }
          }
          eventsSucceeded = envelope.ok && !payload.error;
        };

        const applyFrame = (
          channelRef: MutableRefObject<number>,
          onFrame: ((data: unknown) => void) | undefined,
          data: unknown,
        ) => {
          if (
            !onFrame
            || !mountedRef.current
            || activeGameIdRef.current !== requestGameId
            || mySeq <= channelRef.current
          ) return;
          channelRef.current = mySeq;
          onFrame(data);
        };

        if (wantEvents || include.length > 0) {
          const res = await fetch(`/api/game-relay-events?${params}`, { signal: controller.signal });
          if (!res.ok) {
            settleRelay(false);
            releaseRelaySlot();
            return false;
          }
          await consumeLivePollStream(res, (envelope) => {
            if (envelope.channel === "relay") {
              if (envelope.ok) applyRelay(envelope.data as GameRelayResponse);
              else {
                settleRelay(false);
                releaseRelaySlot();
                armEventsTailTimeout();
              }
            } else if (envelope.channel === "events") {
              applyEvents(envelope);
            } else if (envelope.channel === "live") {
              applyFrame(liveFrameOwnerSeqRef, options?.onLiveFrame, envelope.data);
            } else if (envelope.channel === "detail") {
              applyFrame(detailFrameOwnerSeqRef, options?.onDetailFrame, envelope.data);
            }
          });
        } else {
          const res = await fetch(`/api/game-relay?${params}`, { signal: controller.signal });
          if (res.ok) applyRelay((await res.json()) as GameRelayResponse);
        }
      } catch {
        // Silently fail(abort/network) — UI shows fallback
      } finally {
        clearEventsTailTimeout();
        abortControllersRef.current.delete(controller);
        settleRelay(relaySucceeded);
        // fence: 후행 요청이 이미 공용 상태를 소유했으면(seq 증가) 늦게 끝난 요청은 clear 하지 않는다.
        releaseRelaySlot();
      }
      // live에서는 relay frame의 즉시 성공만 중요하다. final에서는 events까지 성공해야
      // 종결 fetch를 완료 처리하며, 부분 실패면 15초 뒤 bounded retry한다.
      return relaySucceeded && (!isFinal || eventsSucceeded);
    })();
    return isFinal ? request : relayResult;
  }, [gameId, currentInning, isFinal, isLive, options?.onDetailFrame, options?.onLiveFrame]);

  // gameId 전환 시 누적 이닝 캐시·폴링 카운터·표시 데이터를 초기화한다. 이것이 없으면
  // 새 경기 첫 폴링이 이전 경기의 캐시(size>0) 때문에 since 를 보내 이전 경기 이닝 위에
  // delta 를 병합한다(교차 오염). 선언 순서상 폴링 effect 보다 먼저 실행된다.
  useEffect(() => {
    activeGameIdRef.current = gameId;
    // 이전 경기의 in-flight 요청을 즉시 abort 하고 seq 를 올려 무효화한다. 이로써 (1) B full 이
    // A 완료를 기다리지 않고 바로 시작하고(inFlightRef 해제), (2) 늦게 끝난 A 의 finally/late-body
    // 가 B 상태를 훼손하지 못하게 한다(삼순 blocker ② (a)(b)).
    for (const controller of abortControllersRef.current) controller.abort();
    abortControllersRef.current.clear();
    requestSeqRef.current++;
    inFlightRef.current = false;
    inFlightPromiseRef.current = null;
    inningsRef.current = new Map();
    seenEventIdsRef.current.clear();
    pollCountRef.current = 0;
    liveFrameOwnerSeqRef.current = 0;
    detailFrameOwnerSeqRef.current = 0;
    finalFetchedRef.current = false;
    setData(null);
    setEvents([]);
    // abort 된 이전 요청의 finally 는 fencing 되어 loading 을 clear 하지 않으므로 여기서 직접 내린다
    // (B 가 live 면 즉시 다시 true, 비-live 면 spinner 가 A 에 갇히지 않게 한다).
    setIsLoading(false);
  }, [gameId]);

  useEffect(() => {
    mountedRef.current = true;
    const controllers = abortControllersRef.current;

    if (isLive) {
      finalFetchedRef.current = false;
      const switchedLiveGame =
        previousLiveGameIdRef.current !== undefined
        && previousLiveGameIdRef.current !== gameId;
      previousLiveGameIdRef.current = gameId;
      // gameId 전환은 이전 경기 in-flight와 무관하게 즉시 첫 fetch를 시작해야 한다.
      // scheduled→live 진입 때만 bounded jitter를 유지해 cross-instance burst를 흩뿌린다.
      const cleanup = switchedLiveGame
        ? (() => {
            void fetchRelay();
            const timer = setInterval(fetchRelay, interval);
            return () => clearInterval(timer);
          })()
        : scheduleJitteredRelayPolling({ fetchRelay, interval }).cleanup;
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") fetchRelay(undefined, { forceEmbed: true });
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        mountedRef.current = false;
        cleanup();
        document.removeEventListener("visibilitychange", onVisibilityChange);
        for (const controller of controllers) controller.abort();
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
          // relay frame 뒤 events tail이 pending일 때만 bound를 적용한다.
          // relay 자체는 서버의 정상 upstream 상한까지 기다려 유효 응답을 폐기하지 않는다.
          const ok = await fetchRelay(FINAL_EVENTS_TAIL_TIMEOUT_MS);
          finalFetchedRef.current = afterFinalFetch(finalFetchedRef.current, ok);
        } finally {
          finalFetchQueued = false;
        }
      };
      fetchFinalRelay();
      const retryTimer = setInterval(fetchFinalRelay, 15000);
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") fetchFinalRelay();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        cancelled = true;
        mountedRef.current = false;
        clearInterval(retryTimer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        for (const controller of controllers) controller.abort();
      };
    }

    return () => {
      mountedRef.current = false;
      for (const controller of controllers) controller.abort();
    };
  }, [fetchRelay, interval, isLive, isFinal]);

  return { data, events, isLoading };
}
