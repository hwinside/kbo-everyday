"use client";

// 홈 섹션별 표시 여부 (기기 로컬 설정). 마이페이지에서 on/off.
// 기본값 = 전부 표시. 숏츠는 기존 키(kbo-shorts-visible)를 재사용해
// HomeHighlights(getShortsVisible)와 설정이 호환되게 한다.

// 팀카드는 필수(토글 없음), 경기카드는 팀카드에 종속 → 토글 대상에서 제외.
// liveOtherTeams(다른 팀 실시간)는 기존 allGames에 묶여 있던 LiveGameBanner를 분리한 독립 섹션.
export type HomeSectionKey =
  | "news"
  | "communityLatest"
  | "communityPopular"
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
  { key: "communityLatest", label: "커뮤니티 최신글", desc: "최애팀 단독 공개 최신글", storageKey: "kbo-home-community-visible" },
  { key: "communityPopular", label: "최근 24시간 인기글", desc: "팀 구분 없이 하트·댓글 많은 글", storageKey: "kbo-home-community-popular-visible" },
  { key: "favPlayers", label: "최애선수 카드", desc: "최애선수 최근 기록", storageKey: "kbo-home-favplayers-visible" },
  { key: "shorts", label: "숏츠", desc: "홈 숏츠 영상 섹션", storageKey: "kbo-shorts-visible" },
  { key: "liveOtherTeams", label: "다른 팀 실시간", desc: "다른 경기 실시간 스코어 (Live 시에만 노출)", storageKey: "kbo-home-livegames-visible" },
  { key: "allGames", label: "전체 경기 현황", desc: "오늘 경기 일정·결과", storageKey: "kbo-home-allgames-visible" },
];

export const HOME_SECTION_KEYS: HomeSectionKey[] = HOME_SECTIONS.map((s) => s.key);

// 기본 섹션 표시 순서(합의안). 팀카드는 배열 밖 최상단 고정이라 제외.
// 순서 설정이 없을 때의 fallback·복원·normalize 모두 이 상수를 단일 소스로 사용한다.
// (HOME_SECTIONS 배열 순서는 마이페이지 토글 목록 표시 순서일 뿐, 홈 렌더 기본순서와 분리.)
export const DEFAULT_SECTION_ORDER: HomeSectionKey[] = [
  "liveOtherTeams",
  "news",
  "communityLatest",
  "communityPopular",
  "favPlayers",
  "shorts",
  "allGames",
];

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
  // 기존 커뮤니티를 숨긴 사용자는 분리된 인기글도 기본 숨김. 이후 두 토글은 독립적이다.
  if (key === "communityPopular") {
    const own = localStorage.getItem(byKey.communityPopular.storageKey);
    if (own !== null) return own !== "0";
    const inherited = localStorage.getItem(byKey.communityLatest.storageKey) !== "0";
    localStorage.setItem(byKey.communityPopular.storageKey, inherited ? "1" : "0");
    return inherited;
  }
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
  // 저장된 순서에 없는 신규/누락 키는 기본 순서(합의안) 위치를 따라 뒤에 붙인다.
  for (const k of DEFAULT_SECTION_ORDER) {
    if (!seen.has(k)) {
      // 신규 인기글은 기존 커뮤니티 위치 바로 뒤에 삽입. 저장된 나머지 순서는 그대로 보존한다.
      if (k === "communityPopular" && result.includes("communityLatest")) {
        result.splice(result.indexOf("communityLatest") + 1, 0, k);
      } else result.push(k);
    }
  }
  return result;
}

export function getSectionOrder(): HomeSectionKey[] {
  if (typeof window === "undefined") return [...DEFAULT_SECTION_ORDER];
  const raw = localStorage.getItem(SECTION_ORDER_KEY);
  if (!raw) return [...DEFAULT_SECTION_ORDER];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_SECTION_ORDER];
    return normalizeOrder(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return [...DEFAULT_SECTION_ORDER];
  }
}

export function setSectionOrder(order: HomeSectionKey[]): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeOrder(order);
  localStorage.setItem(SECTION_ORDER_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new Event(HOME_SECTIONS_PREF_EVENT));
}

// ── 기본값 복원 ─────────────────────────────────────────────
// 순서(SECTION_ORDER_KEY) + 모든 섹션 표시 토글(각 storageKey)을 기본값으로 리셋.
// 키 자체를 제거 → getSectionOrder는 DEFAULT_SECTION_ORDER, getSectionVisible는 전부 on(기본)으로 복귀.
// 이벤트를 발화해 홈·마이페이지 UI가 즉시 반영되게 한다(숏츠 호환 이벤트 포함).
export function resetSections(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(SECTION_ORDER_KEY);
  for (const s of HOME_SECTIONS) {
    localStorage.removeItem(s.storageKey);
  }
  window.dispatchEvent(new Event(HOME_SECTIONS_PREF_EVENT));
  window.dispatchEvent(new Event(SHORTS_PREF_EVENT));
}
