"use client";

// 홈 섹션별 표시 여부 (기기 로컬 설정). 마이페이지에서 on/off.
// 기본값 = 전부 표시. 숏츠는 기존 키(kbo-shorts-visible)를 재사용해
// HomeHighlights(getShortsVisible)와 설정이 호환되게 한다.

// 팀카드는 필수(토글 없음), 경기카드는 팀카드에 종속 → 토글 대상에서 제외.
export type HomeSectionKey =
  | "news"
  | "favPlayers"
  | "shorts"
  | "liveGames"
  | "allGames";

interface SectionDef {
  key: HomeSectionKey;
  label: string;
  desc: string;
  storageKey: string;
}

// 토글 가능한 홈 섹션 (팀카드=필수·경기카드=종속이라 제외). 표시 순서 = 홈 배열 순서.
export const HOME_SECTIONS: SectionDef[] = [
  { key: "news", label: "뉴스", desc: "주요 뉴스 카드", storageKey: "kbo-home-news-visible" },
  { key: "favPlayers", label: "최애선수 카드", desc: "최애선수 최근 기록", storageKey: "kbo-home-favplayers-visible" },
  { key: "shorts", label: "숏츠", desc: "홈 숏츠 영상 섹션", storageKey: "kbo-shorts-visible" },
  { key: "liveGames", label: "다른 팀 실시간", desc: "(Live시에만 노출)", storageKey: "kbo-home-livegames-visible" },
  { key: "allGames", label: "전체 경기 현황", desc: "오늘 경기 일정·결과", storageKey: "kbo-home-allgames-visible" },
];

export const HOME_SECTIONS_PREF_EVENT = "home-sections-pref-changed";
const SHORTS_PREF_EVENT = "shorts-pref-changed"; // 기존 HomeHighlights 호환용

const byKey = Object.fromEntries(
  HOME_SECTIONS.map((s) => [s.key, s]),
) as Record<HomeSectionKey, SectionDef>;

export type HomeSectionVisibility = Record<HomeSectionKey, boolean>;

export const ALL_VISIBLE: HomeSectionVisibility = Object.fromEntries(
  HOME_SECTIONS.map((s) => [s.key, true]),
) as HomeSectionVisibility;

export function getSectionVisible(key: HomeSectionKey): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(byKey[key].storageKey) !== "0";
}

export function setSectionVisible(key: HomeSectionKey, visible: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(byKey[key].storageKey, visible ? "1" : "0");
  window.dispatchEvent(new Event(HOME_SECTIONS_PREF_EVENT));
  // 숏츠는 기존 HomeHighlights가 SHORTS_PREF_EVENT를 듣고 있으므로 함께 발화.
  if (key === "shorts") window.dispatchEvent(new Event(SHORTS_PREF_EVENT));
}

export function getAllSectionVisibility(): HomeSectionVisibility {
  return Object.fromEntries(
    HOME_SECTIONS.map((s) => [s.key, getSectionVisible(s.key)]),
  ) as HomeSectionVisibility;
}
