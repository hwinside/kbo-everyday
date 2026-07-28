"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  isKeyboardOpen,
  detectKeyboardClose,
  shouldResetViewport,
  snapshotViewport,
} from "@/lib/utils/viewport-reset";

/**
 * iOS 26 WKWebView post-keyboard visualViewport 완화 + 계측.
 *
 * WebKit 297779는 키보드 dismiss 뒤 offsetTop 잔존과 fixed 요소 이동을 기록하며,
 * 제보자 native telemetry도 iOS 26이라 이번 현상과의 연관성은 plausible하다.
 * 다만 scroll nudge가 실제 제보 기기에서 offsetTop을 복구하는지는 아직 미검증이다.
 *
 * 키보드 닫힘 또는 라우트 변경 뒤 offsetTop이 잔존할 때만 완화용 scroll nudge를
 * 실행한다. `localStorage["vv-debug"]="1"`이면 nudge 전후 값을 기록해 실기기
 * 효능을 판정한다. 정상 offsetTop=0 및 비터치 환경에서는 no-op이다.
 *
 * ⚠️ transform/will-change 를 fixed TabBar 에 다시 넣지 말 것(#420/#445).
 */
export default function KeyboardViewportReset() {
  const pathname = usePathname();
  const keyboardOpenRef = useRef(false);

  // 키보드 닫힘 감지 → 잔존 offsetTop 리셋.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    if (window.matchMedia && !window.matchMedia("(pointer: coarse)").matches) return;

    let debug = false;
    try {
      debug = window.localStorage?.getItem("vv-debug") === "1";
    } catch {
      debug = false;
    }

    const resetIfStale = (trigger: string) => {
      const now = window.visualViewport;
      if (!now || !shouldResetViewport(now.offsetTop)) return;
      if (debug) {
        console.log("[vv-reset]", {
          trigger,
          phase: "before-nudge",
          ...snapshotViewport(now, window.innerHeight),
        });
      }
      const y = window.scrollY;
      window.scrollTo(0, y + 1);
      window.scrollTo(0, y);
      if (debug) {
        requestAnimationFrame(() => {
          const after = window.visualViewport;
          if (!after) return;
          console.log("[vv-reset]", {
            trigger,
            phase: "after-nudge",
            ...snapshotViewport(after, window.innerHeight),
          });
        });
      }
    };

    const onResize = () => {
      const nowOpen = isKeyboardOpen(window.innerHeight, vv.height);
      if (debug) {
        console.log("[vv-reset]", {
          trigger: "viewport-resize",
          phase: "observed",
          ...snapshotViewport(vv, window.innerHeight),
        });
      }
      if (detectKeyboardClose(keyboardOpenRef.current, nowOpen)) {
        requestAnimationFrame(() => resetIfStale("keyboard-close:raf"));
        window.setTimeout(() => resetIfStale("keyboard-close:120ms"), 120);
        window.setTimeout(() => resetIfStale("keyboard-close:350ms"), 350);
      }
      keyboardOpenRef.current = nowOpen;
    };

    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  // 라우트 변경 뒤 잔존 offsetTop 완화(예: DM 키보드 → 마이페이지 이동).
  useEffect(() => {
    if (!window.visualViewport) return;
    if (window.matchMedia && !window.matchMedia("(pointer: coarse)").matches) return;
    const id = requestAnimationFrame(() => {
      const now = window.visualViewport;
      if (!now || !shouldResetViewport(now.offsetTop)) return;
      let debug = false;
      try {
        debug = window.localStorage?.getItem("vv-debug") === "1";
      } catch {
        debug = false;
      }
      if (debug) {
        console.log("[vv-reset]", {
          trigger: "route-change",
          phase: "before-nudge",
          ...snapshotViewport(now, window.innerHeight),
        });
      }
      const y = window.scrollY;
      window.scrollTo(0, y + 1);
      window.scrollTo(0, y);
      if (debug) {
        requestAnimationFrame(() => {
          const after = window.visualViewport;
          if (!after) return;
          console.log("[vv-reset]", {
            trigger: "route-change",
            phase: "after-nudge",
            ...snapshotViewport(after, window.innerHeight),
          });
        });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  return null;
}
