"use client";

import { useEffect } from "react";
import { isNativeRuntime } from "@/lib/capacitor/platform";
import { supabase } from "@/lib/supabase/client";
import { syncNativePushToken, listenForTokenRefresh, listenForForegroundNotifications } from "@/lib/native-push";
import { listenForNotificationTap } from "@/lib/native-push-deeplink";
import { bootstrapLiveActivityPushToStart, reregisterPushToStartToken, autoStartMyTeamLiveActivity } from "@/lib/native-live-activity";
import { bootstrapAndroidLockCardGate } from "@/lib/capacitor/game-notification";
import { listenForAndroidBackButton } from "@/lib/native-back-button";

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
    // Android 뒤로가기 처리 — 자체적으로 Android 네이티브를 판정(주입 브릿지 폴백 포함)하므로
    // 원격 로드 시 npm core의 isNative 오판(web) 케이스에도 동작하도록 게이트 앞에서 호출.
    void listenForAndroidBackButton();
    // 알림 탭 딥링크도 정적 core 판정 밖에서 호출한다. remote server.url 앱은 npm core가
    // web으로 오판해도 주입된 window.Capacitor를 통해 native runtime으로 판정해야 한다.
    // background 탭(#1070) + cold-start 탭(#1198)을 한 pending 저장소로 수렴시킨다.
    void listenForNotificationTap();
    if (!isNativeRuntime()) return;
    void syncNativePushToken();
    void listenForTokenRefresh();
    void listenForForegroundNotifications();
    // W3b — 잠금화면 Live Activity 자동 시작용 push-to-start 토큰 등록(iOS 17.2+, 그 외 no-op).
    void bootstrapLiveActivityPushToStart();
    // 안드 잠금카드 게이트 — 서버 live_activity pref를 네이티브에 미러(타 기기서 꺼둔 유저/재설치 복원).
    void bootstrapAndroidLockCardGate();
    // 재설치 same-token 감지 갭 보완(삼순 blocker②) — 첫 실행/복귀 시점에 현재 라이브
    // 최애팀 경기 카드를 인앱 start로 직접 보장(p2s claim 상태 무관, 네이티브 dedupe).
    void autoStartMyTeamLiveActivity("boot");
    // team-changed는 throttle bypass — 부팅/포그라운드 선행 시도(최애팀 미설정이라 no-op)가
    // 최애팀 설정 직후 60초 스로틀에 걸려 start를 막으면 안 됨(삼순 blocker② 보완②).
    const onTeamChanged = () => void autoStartMyTeamLiveActivity("team-changed", true);
    const onVisible = () => {
      if (document.visibilityState === "visible") void autoStartMyTeamLiveActivity("foreground");
    };
    window.addEventListener("team-changed", onTeamChanged);
    document.addEventListener("visibilitychange", onVisible);

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      // ⚠️ onAuthStateChange 콜백 안에서 supabase 함수를 직접 호출하면 auth 락
      // 경합으로 이후 모든 쿼리가 pending될 수 있음 (supabase-js 공식 경고).
      // 신규가입 직후 ProfileSetupModal "생성 중…" 영구 스턱의 원인으로 추정 —
      // setTimeout으로 콜백(락) 컨텍스트 밖에서 실행 (2026-06-11 애플 가입 hotfix)
      if (event === "SIGNED_IN") setTimeout(() => {
        void syncNativePushToken();
        reregisterPushToStartToken(); // W3b — 비로그인 부팅 시 skip된 push-to-start 토큰 등록
        // 재설치 후 로그인 직후 — 프로필 myTeam 동기화 되면 team-changed가 따로 잡지만,
        // 이미 localStorage에 있던 경우(계정 유지 재로그인)는 여기서 보장.
        void autoStartMyTeamLiveActivity("signed-in");
        // 로그인 직후 — 계정 pref로 안드 잠금카드 게이트 재동기화(기기 공유/재로그인).
        void bootstrapAndroidLockCardGate();
      }, 0);
    });
    return () => {
      window.removeEventListener("team-changed", onTeamChanged);
      document.removeEventListener("visibilitychange", onVisible);
      subscription.unsubscribe();
    };
  }, []);
  return null;
}
