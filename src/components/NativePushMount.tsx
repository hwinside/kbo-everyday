"use client";

import { useEffect } from "react";
import { isNative } from "@/lib/capacitor/platform";
import { syncNativePushToken, listenForTokenRefresh } from "@/lib/native-push";

/**
 * 네이티브 앱(iOS/Android) FCM 토큰 동기화용 얇은 클라이언트 마운트.
 * 렌더 출력 없음. `src/app/layout.tsx` body에 주입.
 *
 * - 부팅 시: 권한이 이미 granted면 최신 토큰을 서버에 재등록 (권한 팝업 없음)
 * - tokenReceived: FCM 토큰 rotate 시 자동 재등록
 * 권한 "요청"은 여기서 하지 않음 — 최애팀 설정 직후(OnboardingFlow)에서만.
 */
export function NativePushMount() {
  useEffect(() => {
    if (!isNative) return;
    void syncNativePushToken();
    void listenForTokenRefresh();
  }, []);
  return null;
}
