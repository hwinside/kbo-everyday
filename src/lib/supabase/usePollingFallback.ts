"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  createPollingFallback,
  type PollingFallbackController,
} from "./polling-fallback";

interface UsePollingFallbackOptions {
  /** 폴백 활성 조건(예: 로그인·대화 존재). false면 폴링 안 함. */
  enabled: boolean;
  /** Realtime 구독이 정상(SUBSCRIBED)인가. false면 폴링 안전망 가동. */
  healthy: boolean;
  /** 폴링 주기(ms). */
  intervalMs: number;
}

/**
 * Realtime 구독이 끊긴 동안에만 load()를 주기 폴링하는 안전망 훅.
 * 정상 구독(healthy=true) 상태에서는 폴링하지 않아 부하 0.
 * (순수 로직은 createPollingFallback, 여기선 React·DOM 배선만 담당.)
 *
 * 반환값 requestLoad 는 초기 load·Realtime refresh 등 폴링 외 재조회도 동일
 * single-flight 로 흘려보내는 단일 request owner 입구다 — 컨슈머가 load 를
 * 직접 부르지 않고 이 입구만 쓰면 훅 전체 동시 요청이 최대 1개로 보장된다.
 */
export function usePollingFallback(
  load: () => void | Promise<void>,
  { enabled, healthy, intervalMs }: UsePollingFallbackOptions,
): (loader?: () => void | Promise<void>) => void {
  const loadRef = useRef(load);
  const enabledRef = useRef(enabled);
  const healthyRef = useRef(healthy);
  const controllerRef = useRef<PollingFallbackController | null>(null);

  // 최신 load 를 ref 에 반영(컨트롤러 콜백이 항상 최신 load 를 호출).
  useEffect(() => { loadRef.current = load; }, [load]);

  useEffect(() => {
    const controller = createPollingFallback<ReturnType<typeof setInterval>>({
      load: () => loadRef.current(),
      intervalMs,
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
      isVisible: () =>
        typeof document === "undefined" ||
        document.visibilityState === "visible",
    });
    controllerRef.current = controller;
    controller.setEnabled(enabledRef.current);
    controller.setHealthy(healthyRef.current);

    const onVisibility = () => controller.onVisibilityChange();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      controller.stop();
      controllerRef.current = null;
    };
  }, [intervalMs]);

  useEffect(() => {
    enabledRef.current = enabled;
    controllerRef.current?.setEnabled(enabled);
  }, [enabled]);

  useEffect(() => {
    healthyRef.current = healthy;
    controllerRef.current?.setHealthy(healthy);
  }, [healthy]);

  // 컨트롤러 생성 이전(마운트 직후 효과 순서)에는 직접 실행하되,
  // 이 훅을 컨슈머 훅 먼저 호출해 배선하면 항상 컨트롤러 경로를 탄다.
  return useCallback((loader?: () => void | Promise<void>) => {
    const controller = controllerRef.current;
    if (controller) {
      controller.requestLoad(loader);
      return;
    }
    void Promise.resolve((loader ?? loadRef.current)()).catch(() => undefined);
  }, []);
}
