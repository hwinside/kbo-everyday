// iOS root scroll lock — body overflow:hidden 만으로는 iOS WKWebView 에서 키보드가 열린 상태의
// native touch drag 가 document/root 를 움직여 배경(경기방)과 fixed viewer 가 함께 스크롤된다
// (하린아빠 A17/iOS 리포트). scrollY 를 저장하고 body 를 position:fixed 로 고정해 root scroll 자체를
// 막고, 해제 시 원위치로 복원한다. 스타일 계산은 순수함수로 분리해 회귀로 고정한다.

export interface ScrollLockStyle {
  position: string;
  top: string;
  left: string;
  right: string;
  width: string;
  overflow: string;
  overscrollBehavior: string;
}

/** 저장된 scrollY 기준으로 root scroll 을 완전히 잠그는 body 스타일을 계산한다(순수). */
export function computeScrollLockStyle(scrollY: number): ScrollLockStyle {
  return {
    position: "fixed",
    top: `-${Math.max(0, Math.round(scrollY))}px`,
    left: "0",
    right: "0",
    width: "100%",
    overflow: "hidden",
    overscrollBehavior: "none",
  };
}

export interface SavedScrollState {
  body: Partial<CSSStyleDeclaration>;
  documentElementOverflow: string;
  scrollY: number;
}

/**
 * root scroll 을 잠그고 복원용 상태를 반환한다(SSR-safe: window/document 없으면 no-op).
 * iOS 에서 position:fixed 로 body 를 고정하므로 시각적 점프를 막기 위해 top 에 -scrollY 를 준다.
 */
export function lockRootScroll(): SavedScrollState | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  const scrollY = window.scrollY || window.pageYOffset || 0;
  const body = document.body;
  const saved: SavedScrollState = {
    body: {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
      overscrollBehavior: body.style.overscrollBehavior,
    },
    documentElementOverflow: document.documentElement.style.overflow,
    scrollY,
  };
  const s = computeScrollLockStyle(scrollY);
  body.style.position = s.position;
  body.style.top = s.top;
  body.style.left = s.left;
  body.style.right = s.right;
  body.style.width = s.width;
  body.style.overflow = s.overflow;
  body.style.overscrollBehavior = s.overscrollBehavior;
  // documentElement(html)도 잠가 iOS 가 root 대신 html 을 스크롤하는 경로 차단
  document.documentElement.style.overflow = "hidden";
  return saved;
}

/** lockRootScroll 이 반환한 상태로 원복하고 원래 scrollY 로 되돌린다. */
export function unlockRootScroll(saved: SavedScrollState | null): void {
  if (!saved || typeof document === "undefined" || typeof window === "undefined") return;
  const body = document.body;
  body.style.position = saved.body.position ?? "";
  body.style.top = saved.body.top ?? "";
  body.style.left = saved.body.left ?? "";
  body.style.right = saved.body.right ?? "";
  body.style.width = saved.body.width ?? "";
  body.style.overflow = saved.body.overflow ?? "";
  body.style.overscrollBehavior = saved.body.overscrollBehavior ?? "";
  document.documentElement.style.overflow = saved.documentElementOverflow ?? "";
  // position:fixed 해제 순간 브라우저가 top:0 으로 점프하므로 저장한 위치로 복원
  window.scrollTo(0, saved.scrollY);
}
