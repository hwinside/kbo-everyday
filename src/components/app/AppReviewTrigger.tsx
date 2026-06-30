"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { detectNativeRuntime, requestAppReview } from "@/lib/native-app-review";

// 앱 실행 10회 이상 + 홈("/") 진입 시 인앱 리뷰 1회 요청(하린아빠 결정).
const LAUNCH_COUNT_KEY = "kbo_launch_count";
const REVIEW_PROMPTED_KEY = "kbo_review_prompted";
const LAUNCH_COUNTED_KEY = "kbo_launch_counted"; // sessionStorage — 한 실행(세션)당 1회만 증가
const LAUNCH_THRESHOLD = 10;

/**
 * 네이티브 앱에서만 동작. 웹에선 전부 no-op.
 * - 콜드 런치마다 실행 횟수 +1 (세션당 1회 가드).
 * - 홈 진입 시 10회 이상 & 미요청이면 리뷰 요청(영구 1회).
 */
export default function AppReviewTrigger() {
  // 1) 앱 실행(콜드 런치) 횟수 카운트 — 네이티브에서만, 세션당 1회.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!(await detectNativeRuntime()) || cancelled) return;
      try {
        if (sessionStorage.getItem(LAUNCH_COUNTED_KEY)) return;
        sessionStorage.setItem(LAUNCH_COUNTED_KEY, "1");
        const prev = parseInt(localStorage.getItem(LAUNCH_COUNT_KEY) || "0", 10) || 0;
        localStorage.setItem(LAUNCH_COUNT_KEY, String(prev + 1));
      } catch {
        /* storage 접근 실패 무시 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2) 홈 진입 시 리뷰 요청 트리거(10회 이상, 영구 1회).
  const pathname = usePathname();
  useEffect(() => {
    if (pathname !== "/") return;
    let cancelled = false;
    (async () => {
      try {
        if (localStorage.getItem(REVIEW_PROMPTED_KEY)) return;
        const count = parseInt(localStorage.getItem(LAUNCH_COUNT_KEY) || "0", 10) || 0;
        if (count < LAUNCH_THRESHOLD) return;
        if (!(await detectNativeRuntime()) || cancelled) return;
        // 네이티브 호출이 실제로 invoke된 경우(=플러그인 등록됨)에만 1회성 마킹.
        // 미등록/UNIMPLEMENTED로 실패하면 마킹 안 함 → 다음 홈 진입에 재시도(삼순 NO-GO 반영).
        const invoked = await requestAppReview();
        if (invoked && !cancelled) {
          localStorage.setItem(REVIEW_PROMPTED_KEY, "1");
        }
      } catch {
        /* 무시 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return null;
}
