"use client";

import { isNative, platform } from "@/lib/capacitor/platform";
import { supabase } from "@/lib/supabase/client";

// 네이티브(iOS/Android) FCM 푸시 토큰 유틸.
// 웹 Web Push는 기존 usePushNotification 경로 유지 — 여기는 native 전용.
// @capacitor-firebase/messaging은 dynamic import로 웹 번들 오염 방지.

// ⚠️ Capacitor plugin proxy를 async 함수에서 직접 반환하면 안 됨 —
// await의 thenable 검사가 proxy의 .then을 네이티브 호출로 변환해
// "FirebaseMessaging.then() is not implemented" 런타임 에러 발생.
// 모듈 namespace(일반 객체)를 반환하고 사용처에서 destructure한다.
function loadMessaging() {
  return import("@capacitor-firebase/messaging");
}

/** 서버에 FCM 토큰 등록 (로그인 필수 — 세션 없으면 조용히 skip) */
export async function registerTokenWithServer(fcmToken: string): Promise<boolean> {
  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) return false;

  const res = await fetch("/api/push/register-device", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ fcmToken, platform }),
  });
  return res.ok;
}

/**
 * 푸시 권한 요청 + FCM 토큰 발급 + 서버 등록.
 * 트리거: 최애팀 설정 직후 (스펙 확정). 실패는 전부 silent — 앱 동작 무영향.
 */
export async function requestNativePushPermission(): Promise<boolean> {
  if (!isNative) return false;
  try {
    const { FirebaseMessaging } = await loadMessaging();
    const { receive } = await FirebaseMessaging.requestPermissions();
    if (receive !== "granted") return false;

    const { token } = await FirebaseMessaging.getToken();
    if (!token) return false;

    // 토큰 서버 등록까지 성공해야 true — 등록 실패(토큰 row 0건)인데 UI가 "알림 켜짐"으로
    // 보이는 false-positive 방지 (삼순 #220).
    return await registerTokenWithServer(token);
  } catch {
    return false;
  }
}

/**
 * 현재 푸시 권한이 허용(granted) 상태인지 확인 (팝업 없음).
 * 기존 회원/재설치 유저에게 "알림 꺼짐" 안내를 띄울지 판단하는 데 사용.
 * 네이티브 아님/오류 시 true(안내 숨김) — 거짓 경보 방지.
 */
export async function checkNativePushPermission(): Promise<boolean> {
  if (!isNative) return true;
  try {
    const { FirebaseMessaging } = await loadMessaging();
    const { receive } = await FirebaseMessaging.checkPermissions();
    return receive === "granted";
  } catch {
    return true;
  }
}

/**
 * 앱 부팅 시 토큰 동기화: 권한이 이미 granted인 경우에만
 * (권한 팝업을 띄우지 않음) 최신 토큰을 서버에 재등록.
 */
export async function syncNativePushToken(): Promise<void> {
  if (!isNative) return;
  try {
    const { FirebaseMessaging } = await loadMessaging();
    const { receive } = await FirebaseMessaging.checkPermissions();
    if (receive !== "granted") return;

    const { token } = await FirebaseMessaging.getToken();
    if (token) await registerTokenWithServer(token);
  } catch {
    // silent — 푸시는 부가 기능
  }
}

/** FCM 토큰 갱신(rotate) 시 서버 재등록 리스너 */
export async function listenForTokenRefresh(): Promise<void> {
  if (!isNative) return;
  try {
    const { FirebaseMessaging } = await loadMessaging();
    await FirebaseMessaging.addListener("tokenReceived", ({ token }) => {
      if (token) void registerTokenWithServer(token);
    });
  } catch {
    // silent
  }
}

/** 알림 탭 → 페이로드 data.url 앱 내 경로로 이동 (딥링크) */
export async function listenForNotificationTap(): Promise<void> {
  if (!isNative) return;
  try {
    const { FirebaseMessaging } = await loadMessaging();
    await FirebaseMessaging.addListener("notificationActionPerformed", (event) => {
      const data = (event.notification?.data ?? {}) as Record<string, unknown>;
      const url = typeof data.url === "string" ? data.url : null;
      if (url && url.startsWith("/")) window.location.href = url;
    });
  } catch {
    // silent
  }
}
