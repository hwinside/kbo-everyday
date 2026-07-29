"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";

/**
 * 안전한 뒤로가기.
 * 헤더가 sticky로 항상 노출되면서 뒤로가기 버튼이 상시 눌릴 수 있게 됐다.
 * 직접 진입/새 탭 등 브라우저 히스토리가 없는 경우 router.back()은 아무 동작도 하지 않는
 * '죽은 버튼'이 되므로, 이 경우 fallback 경로(기본 홈)로 이동시킨다.
 *
 * @param fallback 히스토리가 없을 때 이동할 경로 (기본 "/")
 */
export function useSafeBack(fallback: string = "/") {
  const router = useRouter();
  return useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(fallback);
  }, [router, fallback]);
}
