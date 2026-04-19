"use client";

import { useEffect } from "react";

/**
 * 광고 어트리뷰션 캡처 훅 (2026-04-19 추가)
 *
 * 배경:
 *   Google OAuth 리다이렉트 이후 `/auth/callback` → `/setup` redirect 과정에서
 *   URL 쿼리스트링(utm_*, gclid 등)이 완전히 유실됨 → GA4가 가입 세션을
 *   `(not set)` 또는 direct로 분류 → Google Ads conversion 매칭 실패.
 *
 * 해결:
 *   랜딩 시점(첫 페이지뷰)에 URL의 광고 파라미터를 sessionStorage에 저장.
 *   OAuth 왕복 후에도 같은 탭이면 값이 유지되므로, 가입 완료 이벤트 발화 시
 *   해당 값을 읽어 GA4 event params + Google Ads conversion `gclid`로 전달.
 *
 * 범위:
 *   - 1차: `onboarding_complete` 이벤트 + Ads `conversion`에만 적용
 *   - 확장은 2차 (team_selected 등) — 오늘은 어트리뷰션 복구만 집중
 *
 * 원칙:
 *   - 첫 유입 값 우선. 이미 저장돼있으면 덮어쓰지 않음 (동일 탭 재방문 보호)
 *   - 파라미터 전무한 재접속에서는 아무 일도 안 함 (기존 값 보존)
 *   - TTL 30분 — 동일 탭 유지 전제, 과거 값 잔존 리스크 최소화
 */

const STORAGE_KEY = "kbo-ad-attribution";
const TTL_MS = 30 * 60 * 1000; // 30분

type AdAttribution = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  captured_at: number;
};

const TRACK_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
] as const;

function readStored(): AdAttribution | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdAttribution;
    // TTL 만료 시 폐기
    if (!parsed?.captured_at || Date.now() - parsed.captured_at > TTL_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(attr: AdAttribution): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(attr));
  } catch {
    // sessionStorage full / disabled — skip
  }
}

/**
 * 현재 URL에서 광고 파라미터 1개라도 있으면 캡처.
 * 이미 저장된 값이 있고 TTL 내면 덮어쓰지 않음 (첫 유입 우선).
 */
export function captureAdAttribution(): void {
  if (typeof window === "undefined") return;

  const params = new URLSearchParams(window.location.search);
  const captured: Partial<AdAttribution> = {};
  let hasAny = false;

  for (const key of TRACK_KEYS) {
    const value = params.get(key);
    if (value) {
      captured[key] = value;
      hasAny = true;
    }
  }

  if (!hasAny) return; // 광고 파라미터 없음 — 기존 저장값 유지

  const existing = readStored();
  if (existing) {
    // 이미 유효 저장값 있음 → 첫 유입 우선, 덮어쓰지 않음
    return;
  }

  writeStored({ ...captured, captured_at: Date.now() });
}

/**
 * GA4 event params에 병합할 attribution 필드 반환.
 * onboarding_complete 발화 시 trackEvent 내부에서 호출됨.
 */
export function getStoredAttributionForEvent(): Record<string, string> {
  const stored = readStored();
  if (!stored) return {};
  const out: Record<string, string> = {};
  if (stored.utm_source) out.ad_utm_source = stored.utm_source;
  if (stored.utm_medium) out.ad_utm_medium = stored.utm_medium;
  if (stored.utm_campaign) out.ad_utm_campaign = stored.utm_campaign;
  if (stored.utm_content) out.ad_utm_content = stored.utm_content;
  if (stored.gclid) out.ad_gclid = stored.gclid;
  if (stored.fbclid) out.ad_fbclid = stored.fbclid;
  return out;
}

/**
 * Google Ads conversion에 gclid 수동 전달용.
 * OAuth 이후 세션 유실로 자동태깅 gclid가 끊기는 케이스를 보완.
 */
export function getStoredGclid(): string | undefined {
  return readStored()?.gclid;
}

/**
 * React 훅: 랜딩/레이아웃 최상단에서 1회 호출.
 * 마운트 시 현재 URL의 광고 파라미터를 캡처 (이미 있으면 유지).
 */
export function useAdAttribution(): void {
  useEffect(() => {
    captureAdAttribution();
  }, []);
}
