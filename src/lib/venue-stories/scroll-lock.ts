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
  releaseGuards: () => void;
}

/**
 * root scroll 강제 복원(window.scrollTo)을 이번 scroll 이벤트에서 수행할지 결정(순수).
 * suppressed(=댓글 모달 오픈 중)이면 복원하지 않는다 — 이 강제 복원 루프가 키보드 열린 상태의
 * visualViewport.scroll 마다 window.scrollTo 를 반복 호출해 iOS 에서 지터를 만든다. 댓글이 열리면
 * 뷰어는 hidden 이고 배경 위치는 이미 body position:fixed(top:-scrollY)로 고정돼 있으므로 강제 복원
 * 루프가 불필요하고 오히려 해롭다(기사 CommentSheet 는 이 루프가 없다 — modal lock 만). 하린아빠 7/26 iOS.
 */
export function shouldRestoreLockedScroll(opts: {
  suppressed: boolean;
  windowScrollY: number;
  savedScrollY: number;
}): boolean {
  if (opts.suppressed) return false;
  return opts.windowScrollY !== opts.savedScrollY;
}

/**
 * root scroll 을 잠그고 복원용 상태를 반환한다(SSR-safe: window/document 없으면 no-op).
 * iOS 에서 position:fixed 로 body 를 고정하므로 시각적 점프를 막기 위해 top 에 -scrollY 를 준다.
 */
/**
 * @param isCommentModalOpen 댓글 모달이 열려 있는지 읽는 getter. 열려 있으면 강제 scroll-restore 를
 *   억제해 기사 CommentSheet 와 동일한 modal lock semantics 로 동작한다(배경 위치 복원은 그대로 유지).
 *   getter 로 받는 이유: lockRootScroll 은 마운트 시 1회만 호출되고 이후 commentsOpen 변화를 리스너가
 *   실시간으로 읽어야 하기 때문(클로저에 값 캡처 X).
 */
export function lockRootScroll(
  isCommentModalOpen?: () => boolean,
): SavedScrollState | null {
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
    releaseGuards: () => {},
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
  // iOS Safari는 키보드 focus 순간 fixed body라도 root를 자동 스크롤할 수 있다.
  // focus 애니메이션/키보드 열린 native drag 중 발생하는 모든 root 이동을 저장 위치로 되돌린다.
  const restoreLockedScroll = () => {
    // 댓글 모달 오픈 중에는 강제 복원 억제 — CommentSheet 와 동일한 modal lock semantics(지터 제거).
    // 배경 위치는 body position:fixed(top:-scrollY)로 이미 고정돼 있어 복원 루프 없어도 안전.
    if (!shouldRestoreLockedScroll({
      suppressed: isCommentModalOpen?.() ?? false,
      windowScrollY: window.scrollY,
      savedScrollY: scrollY,
    })) {
      return;
    }
    window.scrollTo(0, scrollY);
    if (document.documentElement.scrollTop !== scrollY) {
      document.documentElement.scrollTop = scrollY;
    }
    if (document.body.scrollTop !== 0) {
      document.body.scrollTop = 0;
    }
  };
  window.addEventListener("scroll", restoreLockedScroll, { passive: true });
  window.visualViewport?.addEventListener("scroll", restoreLockedScroll, { passive: true });
  saved.releaseGuards = () => {
    window.removeEventListener("scroll", restoreLockedScroll);
    window.visualViewport?.removeEventListener("scroll", restoreLockedScroll);
  };
  return saved;
}

/** lockRootScroll 이 반환한 상태로 원복하고 원래 scrollY 로 되돌린다. */
export function unlockRootScroll(saved: SavedScrollState | null): void {
  if (!saved || typeof document === "undefined" || typeof window === "undefined") return;
  saved.releaseGuards();
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
