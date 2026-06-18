"use client";

import { useCallback, useEffect, useState } from "react";

function getAdminPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

/**
 * 어드민 좌측 메뉴 배지용 — 운영팀 계정의 안읽은 쪽지 총 갯수.
 * 어드민은 Supabase 세션이 아닌 PIN 인증이라 client realtime 구독이 불가하므로
 * 폴링 + 탭 포커스 복귀 시 재조회로 갱신한다.
 * enabled=true로 바뀌는 순간(PIN 인증 완료) 즉시 1회 재조회한다.
 */
export function useAdminUnreadDMCount(pollMs = 30000, enabled = true): number {
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    const pin = getAdminPin();
    if (!pin) return;
    try {
      const res = await fetch("/api/admin/messages?count=unread", {
        headers: { "x-admin-pin": pin },
      });
      if (res.ok) {
        const json = await res.json();
        setCount(typeof json.unreadTotal === "number" ? json.unreadTotal : 0);
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
