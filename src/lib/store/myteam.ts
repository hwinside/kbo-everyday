"use client";

const STORAGE_KEY = "kbo-my-team";

export function getMyTeamId(): number | null {
  if (typeof window === "undefined") return null;
  const val = localStorage.getItem(STORAGE_KEY);
  return val ? parseInt(val, 10) : null;
}

export function setMyTeamId(teamId: number): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, String(teamId));
}

export function clearMyTeamId(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}
