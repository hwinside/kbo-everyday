"use client";

import { useAdAttribution } from "@/hooks/useAdAttribution";

/**
 * 랜딩 시점 광고 파라미터 캡처용 얇은 클라이언트 마운트.
 * 렌더 출력 없음. `src/app/layout.tsx` body 최상단에 주입.
 *
 * OAuth 왕복으로 URL 쿼리스트링이 유실되는 케이스를 보완하기 위해
 * 첫 페이지뷰 시 sessionStorage에 utm_*, gclid 등을 저장한다.
 * onboarding_complete 이벤트 발화 시 analytics.ts에서 읽어 GA4/Ads에 전달.
 */
export function AdAttributionMount() {
  useAdAttribution();
  return null;
}
