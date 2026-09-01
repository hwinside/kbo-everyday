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
 *
 * 중첩 대화상자: 부모 위에 자식 모달이 열리는 동안 부모는
 * `trapEnabled: false`로 trap만 정지시킨다 (열림 lifecycle은 유지).
 * 자식이 닫히면 자식 훅이 트리거(부모 내부 요소)로 포커스를 복귀시키고,
 * 부모가 닫히면 부모 훅이 원 opener로 복귀시킨다.
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

export function useDialogFocus(
  isOpen: boolean,
  options?: { trapEnabled?: boolean },
) {
  const trapEnabled = options?.trapEnabled ?? true;
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // 열림 lifecycle: 초기 포커스 이동 + 닫힐 때 이전 포커스 복귀.
  // trap suspend(자식 모달 열림)와 무관하게 isOpen 에만 결속한다 —
  // suspend 때 복귀가 실행되면 포커스가 부모 밖으로 새기 때문.
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    dialog.focus({ preventScroll: true });

    return () => {
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [isOpen]);

  // focus trap: Tab / Shift+Tab 내부 순환. 자식 모달이 위에 열린 동안
  // trapEnabled=false 로 정지시켜 초점이 자식 쪽에서 순환하게 한다.
  useEffect(() => {
    if (!isOpen || !trapEnabled) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

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
    };
  }, [isOpen, trapEnabled]);

  return dialogRef;
}
