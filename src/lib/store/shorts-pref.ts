"use client";

import type { ShortsScope } from "@/lib/video/shorts-feed-scope";

// 홈 숏츠 섹션 표시 여부 (기기 로컬 설정). 기본값 = 표시(true).
const STORAGE_KEY = "kbo-shorts-visible";
export const SHORTS_PREF_EVENT = "shorts-pref-changed";

export function getShortsVisible(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(STORAGE_KEY) !== "0";
}

export function setShortsVisible(visible: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, visible ? "1" : "0");
  window.dispatchEvent(new Event(SHORTS_PREF_EVENT));
}

// 숏츠 scope 칩 선택 (최애선수 | 마이팀 | 전체). null = 기존 혼합 피드(기본값).
const SCOPE_STORAGE_KEY = "kbo-shorts-scope";

export function getShortsScope(): ShortsScope | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(SCOPE_STORAGE_KEY);
  return raw === "favorite_players" || raw === "my_team" || raw === "all"
    ? raw
    : null;
}

export function setShortsScope(scope: ShortsScope | null): void {
  if (typeof window === "undefined") return;
  if (scope) localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  else localStorage.removeItem(SCOPE_STORAGE_KEY);
}
