"use client";

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
