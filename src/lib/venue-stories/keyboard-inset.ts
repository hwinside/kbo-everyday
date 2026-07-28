// iOS 키보드 회피 — visualViewport 기반 인셋 계산(순수) + 구독 래퍼.
// iOS Safari/WKWebView 는 키보드가 떠도 레이아웃 뷰포트(innerHeight)가 그대로라
// absolute bottom+safe-area 만으로는 fixed composer 가 키보드에 덮인다.
// 시각 뷰포트와의 차이를 인셋으로 환산해 bottom 에 더한다(CommentSheet 패턴).
// 스모크(qa:venue-story-comments)가 모킹 visualViewport 로 resize 반영을 회귀 검증한다.

/** 키보드 인셋(px) = 레이아웃 뷰포트 높이 - 시각 뷰포트 높이 - 시각 뷰포트 상단 오프셋 (음수 방지) */
export function computeKeyboardInset(
  innerHeight: number,
  viewportHeight: number,
  viewportOffsetTop: number,
): number {
  return Math.max(0, innerHeight - viewportHeight - viewportOffsetTop);
}

/** focus가 먼저 풀려도 visualViewport 인셋이 남은 키보드 닫힘 애니메이션까지 open으로 본다. */
export function isVenueStoryKeyboardOpen(
  composerFocused: boolean,
  keyboardInset: number,
): boolean {
  return composerFocused || keyboardInset > 0;
}

/** subscribeKeyboardInset 이 요구하는 최소 visualViewport 인터페이스(모킹 가능) */
export interface VisualViewportLike {
  readonly height: number;
  readonly offsetTop: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
}

/**
 * visualViewport resize/scroll 을 구독해 인셋 변화를 onInset 으로 전달.
 * 구독 즉시 1회 적용하고, 반환된 함수로 해제한다(해제 후 콜백 없음).
 */
export function subscribeKeyboardInset(
  vv: VisualViewportLike,
  getInnerHeight: () => number,
  onInset: (inset: number) => void,
): () => void {
  const apply = () => {
    onInset(computeKeyboardInset(getInnerHeight(), vv.height, vv.offsetTop));
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
  };
}
