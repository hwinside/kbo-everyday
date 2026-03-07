"use client";

const STORAGE_KEY = "kbo-my-team";

export function getMyTeamId(): number | null {
  if (typeof window === "undefined") return null;
  const val = localStorage.getItem(STORAGE_KEY);
  return val ? parseInt(val, 10) : null;
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
