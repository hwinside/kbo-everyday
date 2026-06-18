"use client";

import { useEffect, useState } from "react";
import {
  ALL_VISIBLE,
  getAllSectionVisibility,
  getSectionOrder,
  DEFAULT_SECTION_ORDER,
  HOME_SECTIONS_PREF_EVENT,
  type HomeSectionKey,
  type HomeSectionVisibility,
} from "@/lib/store/home-sections-pref";

// 홈 섹션 표시 여부 구독. SSR/hydration 불일치 방지 위해 초기값은 전부 표시,
// 마운트 후 localStorage 읽어 동기화(숏츠 토글과 동일 패턴).
export function useHomeSectionsPref(): HomeSectionVisibility {
  const [visibility, setVisibility] = useState<HomeSectionVisibility>(ALL_VISIBLE);

  useEffect(() => {
    const update = () => setVisibility(getAllSectionVisibility());
    update();
    window.addEventListener(HOME_SECTIONS_PREF_EVENT, update);
    return () => window.removeEventListener(HOME_SECTIONS_PREF_EVENT, update);
  }, []);

  return visibility;
}

// 홈 섹션 순서 구독. SSR/hydration 불일치 방지 위해 초기값은 기본 순서,
// 마운트 후 localStorage 읽어 동기화(visibility 훅과 동일 패턴).
export function useHomeSectionsOrder(): HomeSectionKey[] {
  const [order, setOrder] = useState<HomeSectionKey[]>(DEFAULT_SECTION_ORDER);

  useEffect(() => {
    const update = () => setOrder(getSectionOrder());
    update();
    window.addEventListener(HOME_SECTIONS_PREF_EVENT, update);
    return () => window.removeEventListener(HOME_SECTIONS_PREF_EVENT, update);
  }, []);

  return order;
}
