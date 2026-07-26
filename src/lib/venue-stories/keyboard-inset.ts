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

/**
 * root-scroll-lock(body position:fixed) 컨텍스트 전용 키보드 인셋 = 레이아웃 뷰포트 높이 - 시각 뷰포트 높이
 * (음수 방지). offsetTop 을 빼지 않는다.
 *
 * 왜 offsetTop 을 무시하나: 직관 스토리 뷰어는 lockRootScroll 로 body 를 position:fixed 로 고정한다.
 * 이때 문서 스크롤은 0 이지만, iOS Safari/WKWebView 는 키보드가 뜰 때 focused input 을 보이려고
 * 시각 뷰포트를 임시로 밀어올려 visualViewport.offsetTop 을 0 이 아닌 값으로 (그리고 키보드 애니메이션
 * 중에는 튀는 값으로) 보고한다. 그 offsetTop 을 빼면 인셋이 실제 키보드 높이보다 작아져(과소 계산)
 * position:fixed 시트가 키보드 위로 덜 올라가고, 하단 입력창이 키보드 뒤로 숨는다(간헐적). CommentSheet 는
 * scroll-lock 이 없어 offsetTop≈0 이라 이 문제가 없다. scroll-lock 컨텍스트에서는 시트/컴포저를 레이아웃
 * 뷰포트 하단 기준으로 키보드 높이(innerHeight - vv.height)만큼만 올리는 것이 안정적이다.
 */
export function computeLockedKeyboardInset(
  innerHeight: number,
  viewportHeight: number,
): number {
  return Math.max(0, innerHeight - viewportHeight);
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
