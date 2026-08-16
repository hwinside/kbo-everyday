"use client";

const STORAGE_KEY = "kbo-my-team";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function parseTeamId(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 마이팀은 localStorage 가 SSOT 이고 **쿠키는 폴백**이다.
 *
 * setMyTeamId 는 항상 둘 다 쓰지만, 앱 웹뷰 재설치·사이트 데이터 삭제 등으로
 * localStorage 만 비고 쿠키는 남아있는 상태가 실제로 존재한다
 * (2026-08-15 Production 실측: 쿠키만 있는 세션에서 /players 가 마이팀이 아닌 전체 883명으로 떴다).
 * localStorage 만 보면 그 상태를 "마이팀 없음" 으로 오판한다.
 */
export function getMyTeamId(): number | null {
  if (typeof window === "undefined") return null;
  let fromStorage: string | null = null;
  try {
    fromStorage = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Safari 프라이빗 등에서 localStorage 접근이 throw 할 수 있다 — 쿠키로 넘어간다.
  }
  const parsed = parseTeamId(fromStorage);
  if (parsed !== null) return parsed;
  return parseTeamId(readCookie(STORAGE_KEY));
}

function setCookie(name: string, value: string, maxAgeSeconds: number) {
  // Lax + path=/ to make it available for server-side redirect.
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax`;
}

function clearCookie(name: string) {
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
}

export function setMyTeamId(teamId: number): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, String(teamId));
  // Persist to cookie so the server can redirect /community straight to /community/teams/{myTeam}
  setCookie(STORAGE_KEY, String(teamId), 60 * 60 * 24 * 365);
  window.dispatchEvent(new Event("team-changed"));
}

export function clearMyTeamId(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
  clearCookie(STORAGE_KEY);
}
