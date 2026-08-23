"use client";

import { useCallback, useEffect, useState } from "react";

// 크관 문자중계 "현재 타석" 자동 포커싱(새 투구 시 scrollIntoView) 사용자 설정.
// 기본값 ON(기존 동작 유지). localStorage 영속 + 커스텀 이벤트로 컴포넌트 간 동기화
// (useHomeSectionsPref와 동일 패턴 — SSR/hydration 불일치 방지 위해 초기값 ON,
// 마운트 후 localStorage 읽어 동기화).
const STORAGE_KEY = "kgwan_auto_focus";
const EVENT_NAME = "kgwan-auto-focus-change";

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function useKgwanAutoFocus(): { enabled: boolean; toggle: () => void } {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    const update = () => setEnabled(readEnabled());
    update();
    window.addEventListener(EVENT_NAME, update);
    return () => window.removeEventListener(EVENT_NAME, update);
  }, []);

  const toggle = useCallback(() => {
    const next = !readEnabled();
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
      // localStorage 불가 환경(사파리 시크릿 등)에서도 이벤트로 세션 내 동기화는 유지
    }
    window.dispatchEvent(new Event(EVENT_NAME));
  }, []);

  return { enabled, toggle };
}
