// iOS 26 WKWebView 키보드 dismiss 후 visualViewport.offsetTop 잔존 방어 (WebKit 297779).
//
// iOS 26 / Capacitor WKWebView 는 소프트 키보드가 닫힌 뒤에도 visualViewport.offsetTop 이
// 0 으로 복귀하지 않고 잔존하는 버그가 있다. 그러면 position:fixed; bottom:0 인 전역 TabBar 가
// "낡은" 시각 뷰포트 기준으로 페인트돼 바닥이 아니라 본문 중앙에 떠 보인다(아래로 콘텐츠가 계속 보임).
// blur/route 이후에 나타나는 persistent 현상이라 focus 중 hide 하는 가드로는 못 고친다.
//
// 처방: 키보드 닫힘(레이아웃↔시각 뷰포트 갭 축소) 또는 라우트 변경 뒤 offsetTop 이 잔존하면
// 스크롤 넛지로 WebKit 이 시각 뷰포트를 재계산하도록 강제한다. offsetTop 이 이미 0 인
// 정상 플랫폼(안드로이드·구 iOS·데스크톱)에서는 no-op 이라 부작용 없음.
//
// 아래 순수 판정 함수를 스모크(qa:viewport-reset)가 모킹 visualViewport 로 회귀 검증한다.

import type { VisualViewportLike } from "../venue-stories/keyboard-inset";

/** 키보드가 열렸다고 볼 레이아웃-시각 뷰포트 최소 갭(px). 주소창 축소 등 소폭 변동과 구분. */
export const KEYBOARD_OPEN_GAP_PX = 100;

/** 리셋을 발동할 offsetTop 임계(px). 이 미만은 정상(0)으로 간주해 no-op. */
export const VIEWPORT_OFFSET_EPSILON = 1;

/** 키보드 열림 판정: (레이아웃 높이 - 시각 뷰포트 높이) 가 임계 초과. */
export function isKeyboardOpen(
  innerHeight: number,
  viewportHeight: number,
  gapPx = KEYBOARD_OPEN_GAP_PX,
): boolean {
  return innerHeight - viewportHeight > gapPx;
}

/** open→closed 전이(키보드가 방금 닫힘)인가. 닫힘 시에만 리셋을 예약한다. */
export function detectKeyboardClose(prevOpen: boolean, nowOpen: boolean): boolean {
  return prevOpen && !nowOpen;
}

/** 리셋 필요? = offsetTop 이 사실상 0 이 아님(버그 실제 발현 시에만 true; 정상 플랫폼은 false→no-op). */
export function shouldResetViewport(
  viewportOffsetTop: number,
  eps = VIEWPORT_OFFSET_EPSILON,
): boolean {
  return Math.abs(viewportOffsetTop) >= eps;
}

/** 실기기 계측 스냅샷(디버그 로깅용). */
export interface ViewportSnapshot {
  offsetTop: number;
  height: number;
  innerHeight: number;
  gap: number;
  keyboardOpen: boolean;
}

export function snapshotViewport(vv: VisualViewportLike, innerHeight: number): ViewportSnapshot {
  const gap = innerHeight - vv.height;
  return {
    offsetTop: vv.offsetTop,
    height: vv.height,
    innerHeight,
    gap,
    keyboardOpen: isKeyboardOpen(innerHeight, vv.height),
  };
}
