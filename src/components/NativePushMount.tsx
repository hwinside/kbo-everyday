"use client";

import { useEffect } from "react";
import { isNative } from "@/lib/capacitor/platform";
import { supabase } from "@/lib/supabase/client";
import { syncNativePushToken, listenForTokenRefresh } from "@/lib/native-push";

/**
 * 네이티브 앱(iOS/Android) FCM 토큰 동기화용 얇은 클라이언트 마운트.
 * 렌더 출력 없음. `src/app/layout.tsx` body에 주입.
 *
 * - 부팅 시: 권한이 이미 granted면 최신 토큰을 서버에 재등록 (권한 팝업 없음)
 * - 로그인 직후(SIGNED_IN): 토큰 재동기화 — 온보딩(비로그인)에서 권한만 받고
 *   서버 등록이 skip된 경우 로그인 시점에 연결
 * - tokenReceived: FCM 토큰 rotate 시 자동 재등록
 * 권한 "요청"은 여기서 하지 않음 — 최애팀 설정 직후(OnboardingFlow)에서만.
 */
export function NativePushMount() {
  useEffect(() => {
    if (!isNative) return;
    void syncNativePushToken();
    void listenForTokenRefresh();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") void syncNativePushToken();
    });
    return () => subscription.unsubscribe();
  }, []);
  return null;
}
