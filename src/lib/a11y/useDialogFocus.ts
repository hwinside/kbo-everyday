"use client";

import { useEffect, useRef } from "react";

/**
 * 시트/모달용 최소 focus contract (접근성 피드백 feedback:b875f09e 지적 1·5).
 *
 * `aria-modal="true"`를 선언한 대화상자가 실제로도 모달처럼 동작하도록:
 * 1) 열릴 때 초기 포커스를 대화상자 컨테이너로 이동 (스크린리더 진입 인지)
 * 2) Tab / Shift+Tab 포커스를 대화상자 내부로 순환 (focus trap)
 * 3) 닫힐 때 이전 포커스 요소로 복귀
 *
 * 사용: 컨테이너(motion.div 등)에 `ref={dialogRef}` + `tabIndex={-1}` 부착.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

export function useDialogFocus(isOpen: boolean) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // 초기 포커스: 대화상자 컨테이너 (tabIndex=-1 필요)
    dialog.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(isVisible);
      if (nodes.length === 0) {
        e.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const insideDialog = active instanceof Node && dialog.contains(active);
      if (e.shiftKey) {
        if (!insideDialog || active === first || active === dialog) {
          e.preventDefault();
          last.focus();
        }
      } else if (!insideDialog || active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [isOpen]);

  return dialogRef;
}
