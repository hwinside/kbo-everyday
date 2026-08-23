"use client";

import { useCallback, useEffect, useState } from "react";

// 크관 문자중계 "현재 타석" 자동 포커싱(새 투구 시 scrollIntoView) 사용자 설정.
// 기본값 ON(기존 동작 유지). localStorage 영속 + 커스텀 이벤트로 컴포넌트 간 동기화
// (useHomeSectionsPref와 동일 패턴 — SSR/hydration 불일치 방지 위해 초기값 ON,
// 마운트 후 localStorage 읽어 동기화).
//
// localStorage 쓰기 실패 환경(사파리 시크릿 등) 대비: 메모리 값을 1차 소스로 두고
// localStorage는 영속 백업으로만 쓴다. 쓰기가 실패해도 세션 내 토글은 항상 동작한다
// (삼순 리뷰 blocker — 쓰기 실패 시 이벤트 수신부가 stale 값을 재독해 토글 무효화되던 결함 수정).
const STORAGE_KEY = "***";
const EVENT_NAME = "kgwan-auto-focus-change";

// 세션 내 1차 소스. null = 아직 localStorage에서 hydrate 전.
let memoryEnabled: boolean | null = null;

function readEnabled(): boolean {
  if (memoryEnabled !== null) return memoryEnabled;
  try {
    memoryEnabled = window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    memoryEnabled = true;
  }
  return memoryEnabled;
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
    memoryEnabled = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
      // 영속만 포기 — 메모리 값이 1차 소스라 토글·구독 동기화는 그대로 동작한다.
    }
    window.dispatchEvent(new Event(EVENT_NAME));
  }, []);

  return { enabled, toggle };
}
