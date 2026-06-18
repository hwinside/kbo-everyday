"use client";

// 홈 섹션별 표시 여부 (기기 로컬 설정). 마이페이지에서 on/off.
// 기본값 = 전부 표시. 숏츠는 기존 키(kbo-shorts-visible)를 재사용해
// HomeHighlights(getShortsVisible)와 설정이 호환되게 한다.

// 팀카드는 필수(토글 없음), 경기카드는 팀카드에 종속 → 토글 대상에서 제외.
// liveOtherTeams(다른 팀 실시간)는 기존 allGames에 묶여 있던 LiveGameBanner를 분리한 독립 섹션.
export type HomeSectionKey =
  | "news"
  | "favPlayers"
  | "shorts"
  | "liveOtherTeams"
  | "allGames";

interface SectionDef {
  key: HomeSectionKey;
  label: string;
  desc: string;
  storageKey: string;
}

// 토글 가능한 홈 섹션 (팀카드=필수·경기카드=종속이라 제외).
// 배열 순서 = 기본 표시 순서(순서 설정이 없을 때 fallback).
export const HOME_SECTIONS: SectionDef[] = [
  { key: "news", label: "뉴스", desc: "주요 뉴스 카드", storageKey: "kbo-home-news-visible" },
  { key: "favPlayers", label: "최애선수 카드", desc: "최애선수 최근 기록", storageKey: "kbo-home-favplayers-visible" },
  { key: "shorts", label: "숏츠", desc: "홈 숏츠 영상 섹션", storageKey: "kbo-shorts-visible" },
  { key: "liveOtherTeams", label: "다른 팀 실시간", desc: "다른 경기 라이브 현황", storageKey: "kbo-home-liveother-visible" },
  { key: "allGames", label: "오늘 전체 경기", desc: "오늘 경기 일정", storageKey: "kbo-home-allgames-visible" },
];

export const HOME_SECTION_KEYS: HomeSectionKey[] = HOME_SECTIONS.map((s) => s.key);

export const HOME_SECTIONS_PREF_EVENT = "home-sections-pref-changed";
const SHORTS_PREF_EVENT = "shorts-pref-changed"; // 기존 HomeHighlights 호환용

// 섹션 순서 저장 키 (섹션키 순서 배열을 JSON으로 저장).
const SECTION_ORDER_KEY = "kbo-home-sections-order";

const byKey = Object.fromEntries(
  HOME_SECTIONS.map((s) => [s.key, s]),
) as Record<HomeSectionKey, SectionDef>;

export type HomeSectionVisibility = Record<HomeSectionKey, boolean>;

export const ALL_VISIBLE: HomeSectionVisibility = Object.fromEntries(
  HOME_SECTIONS.map((s) => [s.key, true]),
) as HomeSectionVisibility;

export function getSectionVisible(key: HomeSectionKey): boolean {
  if (typeof window === "undefined") return true;
  // liveOtherTeams는 신규 분리 키. 자체 설정이 없으면 기존 allGames 설정을 상속
  // (기존 allGames=on이면 둘 다 on, off면 둘 다 off로 호환).
  if (key === "liveOtherTeams") {
    const own = localStorage.getItem(byKey.liveOtherTeams.storageKey);
    if (own === null) {
      return localStorage.getItem(byKey.allGames.storageKey) !== "0";
    }
    return own !== "0";
  }
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

// ── 섹션 순서 ───────────────────────────────────────────────
// localStorage(kbo-home-sections-order)에 섹션키 순서 배열을 저장.
// 저장값을 정규화: 알 수 없는 키 제거 + 누락된 신규 키는 기본 위치 append(forward-compat).
function normalizeOrder(saved: string[]): HomeSectionKey[] {
  const valid = new Set<HomeSectionKey>(HOME_SECTION_KEYS);
  const seen = new Set<HomeSectionKey>();
  const result: HomeSectionKey[] = [];
  for (const k of saved) {
    if (valid.has(k as HomeSectionKey) && !seen.has(k as HomeSectionKey)) {
      result.push(k as HomeSectionKey);
      seen.add(k as HomeSectionKey);
    }
  }
  // 저장된 순서에 없는 신규/누락 키는 기본 순서 위치를 따라 뒤에 붙인다.
  for (const k of HOME_SECTION_KEYS) {
    if (!seen.has(k)) result.push(k);
  }
  return result;
}

export function getSectionOrder(): HomeSectionKey[] {
  if (typeof window === "undefined") return [...HOME_SECTION_KEYS];
  const raw = localStorage.getItem(SECTION_ORDER_KEY);
  if (!raw) return [...HOME_SECTION_KEYS];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...HOME_SECTION_KEYS];
    return normalizeOrder(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return [...HOME_SECTION_KEYS];
  }
}

export function setSectionOrder(order: HomeSectionKey[]): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeOrder(order);
  localStorage.setItem(SECTION_ORDER_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new Event(HOME_SECTIONS_PREF_EVENT));
}
