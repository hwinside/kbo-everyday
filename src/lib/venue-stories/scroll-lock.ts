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
 * root scroll 강제 복원 계획을 계산한다(순수). scroll 이벤트마다 호출되어 window/html/body 각각의
 * 이탈을 독립적으로 복원할지 결정한다.
 *
 * - suppressed(=댓글 모달 오픈 중)이면 전체 no-op. 이 강제 복원 루프가 키보드 열린 상태의
 *   visualViewport.scroll 마다 window.scrollTo 를 반복 호출해 iOS 지터를 만든다. 댓글 열리면 뷰어는
 *   hidden, 배경 위치는 body position:fixed(top:-scrollY)로 이미 고정 → 억제해도 안전(기사 CommentSheet 동일).
 * - suppressed 가 아니면(스토리만 보는 중) #839 배경 밀림 방지 위해 window(scrollY||pageYOffset)/html/body 이탈을
 *   각각 독립 복원한다(window.scrollY 하나만 보고 short-circuit 하지 않음 — 삼순 #884 왕복2 blocker).
 */
export interface ScrollRestorePlan {
  scrollTo: boolean;
  htmlScrollTop: number | null;
  bodyScrollTop: number | null;
}
export function computeScrollRestore(opts: {
  suppressed: boolean;
  windowScrollY: number;
  pageYOffset: number;
  htmlScrollTop: number;
  bodyScrollTop: number;
  savedScrollY: number;
}): ScrollRestorePlan {
  if (opts.suppressed) {
    return { scrollTo: false, htmlScrollTop: null, bodyScrollTop: null };
  }
  return {
    scrollTo:
      opts.windowScrollY !== opts.savedScrollY || opts.pageYOffset !== opts.savedScrollY,
    htmlScrollTop: opts.htmlScrollTop !== opts.savedScrollY ? opts.savedScrollY : null,
    bodyScrollTop: opts.bodyScrollTop !== 0 ? 0 : null,
  };
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
    // 댓글 모달 오픈 중이면 전체 no-op(CommentSheet modal lock semantics). 아니면 window/html/body
    // 각 이탈을 독립 복원(#839 배경 밀림 방지). 계획은 computeScrollRestore 순수함수로 계산해 회귀 고정.
    const plan = computeScrollRestore({
      suppressed: isCommentModalOpen?.() ?? false,
      windowScrollY: window.scrollY,
      pageYOffset: window.pageYOffset,
      htmlScrollTop: document.documentElement.scrollTop,
      bodyScrollTop: document.body.scrollTop,
      savedScrollY: scrollY,
    });
    if (plan.scrollTo) {
      window.scrollTo(0, scrollY);
    }
    if (plan.htmlScrollTop !== null) {
      document.documentElement.scrollTop = plan.htmlScrollTop;
    }
    if (plan.bodyScrollTop !== null) {
      document.body.scrollTop = plan.bodyScrollTop;
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
