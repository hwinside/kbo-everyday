// iOS 26 WKWebView 키보드 dismiss 후 visualViewport.offsetTop 잔존 완화 (WebKit 297779).
//
// WebKit 297779가 기록한 iOS 26 / Capacitor WKWebView 증상은 이번 제보와 유사하고,
// 제보자 native telemetry도 iOS 26이다. 다만 동일 원인 및 아래 scroll nudge의 효능은
// 실제 제보 기기에서 아직 확인되지 않았다.
//
// 완화: 키보드 닫힘 또는 라우트 변경 뒤 offsetTop이 잔존할 때 scroll nudge를 시도한다.
// offsetTop이 0인 환경에서는 no-op이며, vv-debug 계측으로 nudge 전후 값을 비교한다.
//
// 스모크는 판정·배선만 검증하며 실제 WKWebView 복구 효능을 증명하지 않는다.

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

/** 완화 시도 필요? = offsetTop 이 사실상 0 이 아님. */
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
