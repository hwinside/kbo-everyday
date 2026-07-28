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
 * 전역 post-keyboard visual-viewport 리셋 (iOS 26 WKWebView / WebKit 297779).
 *
 * iOS 26 에서 키보드 dismiss 후 visualViewport.offsetTop 이 0 으로 복귀하지 않고
 * 잔존하면, position:fixed 인 전역 TabBar 가 낡은 시각 뷰포트 기준으로 밀려
 * 본문 중앙에 뜬다. blur/route 이후에 나타나는 persistent 현상이라 focus-only
 * hide 로는 못 고친다(stella24 CS: DM 입력 → 닫기/마이 이동 후 마이페이지에서 발현).
 *
 * 한 번만 마운트되어, 키보드 닫힘 OR 라우트 변경 뒤 offsetTop 이 잔존하면
 * 스크롤 넛지로 WebKit 이 시각 뷰포트를 재계산하게 한다. offsetTop 이 이미 0 인
 * 정상 플랫폼에서는 shouldResetViewport 가 false → no-op 이라 스크롤이 안 튄다.
 * coarse 포인터(터치)에서만 동작.
 *
 * ⚠️ transform/will-change 를 fixed TabBar 에 다시 넣지 말 것(#420/#445). 여기 리셋은
 * 시각 뷰포트 자체를 되돌릴 뿐 TabBar 에 합성 속성을 부여하지 않는다.
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

    const resetIfStale = () => {
      const now = window.visualViewport;
      if (!now || !shouldResetViewport(now.offsetTop)) return;
      const y = window.scrollY;
      window.scrollTo(0, y + 1);
      window.scrollTo(0, y);
    };

    const onResize = () => {
      const nowOpen = isKeyboardOpen(window.innerHeight, vv.height);
      if (debug) {
        // 실기기 진단: 키보드 상태 전이마다 vv.offsetTop/height vs innerHeight 로깅.
        console.log("[vv-reset]", snapshotViewport(vv, window.innerHeight));
      }
      if (detectKeyboardClose(keyboardOpenRef.current, nowOpen)) {
        // 닫힘 직후 한 프레임 + 늦은 백업 2회(WebKit 이 늦게 offsetTop 을 흘리는 케이스).
        requestAnimationFrame(resetIfStale);
        window.setTimeout(resetIfStale, 120);
        window.setTimeout(resetIfStale, 350);
      }
      keyboardOpenRef.current = nowOpen;
    };

    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  // 라우트 변경 후 잔존 offsetTop 리셋(예: DM 키보드 → 마이페이지 이동, forward nav 는 popstate 미발화).
  useEffect(() => {
    if (!window.visualViewport) return;
    if (window.matchMedia && !window.matchMedia("(pointer: coarse)").matches) return;
    const id = requestAnimationFrame(() => {
      const now = window.visualViewport;
      if (!now || !shouldResetViewport(now.offsetTop)) return;
      const y = window.scrollY;
      window.scrollTo(0, y + 1);
      window.scrollTo(0, y);
    });
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  return null;
}
