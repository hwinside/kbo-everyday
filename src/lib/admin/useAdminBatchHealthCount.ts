"use client";

import { useCallback, useEffect, useState } from "react";

function getAdminPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

/**
 * 어드민 좌측 메뉴 "크롤러/배치" 배지용 — 문제(stale/error) 상태 job 갯수.
 * 쪽지함 unread 배지와 동일 패턴(PIN 인증이라 realtime 불가 → 폴링 + 포커스 복귀 재조회).
 * 멈춘 크론/데이터 동결을 조용히 지나치지 않게 상단 네비에 상시 노출한다.
 */
export function useAdminBatchHealthCount(pollMs = 60000, enabled = true): number {
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    const pin = getAdminPin();
    if (!pin) return;
    try {
      const res = await fetch("/api/admin/jobs/health", {
        headers: { "x-admin-pin": pin },
      });
      if (res.ok) {
        const json = await res.json();
        setCount(typeof json.problemCount === "number" ? json.problemCount : 0);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    load(); // eslint-disable-line react-hooks/set-state-in-effect
    const interval = setInterval(load, pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", load);
    };
  }, [load, pollMs, enabled]);

  return count;
}
