"use client";

import { useEffect } from "react";

const KEY = "kbo-my-team";

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, maxAgeSeconds: number) {
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax`;
}

/**
 * Ensures myTeam is available to the server via cookie, so `/community` can redirect
 * straight to `/community/teams/{myTeam}` without a client-side flash.
 */
export default function MyTeamCookieSync() {
  useEffect(() => {
    try {
      const ls = localStorage.getItem(KEY);
      if (!ls) return;
      const cookieVal = getCookie(KEY);
      if (cookieVal === ls) return;
      setCookie(KEY, ls, 60 * 60 * 24 * 365);
    } catch {
      // ignore
    }
  }, []);

  return null;
}
