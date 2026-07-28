"use client";

import { useEffect } from "react";

/**
 * Global keyboard-aware TabBar guard.
 *
 * On iOS WKWebView / mobile Safari a `position: fixed; bottom: 0` element is
 * pinned to the *visual* viewport, so when the soft keyboard opens it rides up
 * above the keyboard and covers the content just below the focused input
 * (stella24 CS: "하단바가 따라 올라와서 콘텐츠를 가립니다"). Composer screens
 * (GameChat / PostDetail) already hide the TabBar via `body.kbd-open`, but every
 * other screen with a plain input/textarea (설정 피드백, 검색, 닉네임 편집 …)
 * had no such guard.
 *
 * This mounts once in the (main) layout and hides the global TabBar whenever an
 * editable element is focused, via a dedicated `kbd-tabbar-hide` body class that
 * only flips `display:none` on `[data-global-tabbar]` (see globals.css). It is
 * intentionally SEPARATE from `kbd-open` so it never touches the composer
 * padding/docking tuned for GameChat/PostDetail — those screens simply hide the
 * TabBar twice, which is harmless.
 *
 * ⚠️ No transform/will-change is introduced (see #420/#445): the fix is purely a
 * `display:none` toggle on focus, matching the existing kbd-open mechanism.
 *
 * Gated to coarse pointers so desktop/mouse focus (which opens no soft keyboard)
 * keeps the TabBar visible.
 */
export default function KeyboardTabBarGuard() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Only devices with a soft keyboard (touch). Desktop focus must NOT hide nav.
    if (!window.matchMedia?.("(pointer: coarse)").matches) return;

    const isEditable = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === "TEXTAREA") return true;
      if (tag === "INPUT") {
        const type = (el as HTMLInputElement).type;
        // Buttons/checkboxes/etc. don't summon the keyboard.
        return !["button", "submit", "reset", "checkbox", "radio", "range", "file", "color", "image"].includes(type);
      }
      return el.isContentEditable;
    };

    const HIDE = "kbd-tabbar-hide";
    const onFocusIn = (e: FocusEvent) => {
      if (isEditable(e.target)) document.body.classList.add(HIDE);
    };
    const onFocusOut = () => {
      // settle: absorb brief blur→refocus from Korean IME toggles before deciding.
      setTimeout(() => {
        if (!isEditable(document.activeElement)) document.body.classList.remove(HIDE);
      }, 100);
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.body.classList.remove(HIDE);
    };
  }, []);

  return null;
}
