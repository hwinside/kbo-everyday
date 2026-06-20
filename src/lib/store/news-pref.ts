"use client";

// 뉴스 표시 설정 (기기 로컬). 마이페이지에서 on/off.
// 사진기사 필터: 포토·화보 위주 기사를 홈·팀 뉴스에서 숨긴다.
// 기본값 = off(전체 노출). 켜면 사진기사 숨김. 판별 로직은 news-relevance(SSOT).

const PHOTO_FILTER_KEY = "kbo-news-photo-filter";
export const NEWS_PREF_EVENT = "news-pref-changed";

export function getPhotoFilterEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(PHOTO_FILTER_KEY) === "1";
}

export function setPhotoFilterEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(PHOTO_FILTER_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new Event(NEWS_PREF_EVENT));
}
