"use client";

import { isNativeRuntime } from "@/lib/capacitor/platform";

const PENDING_TAP_KEY = "keubo.pending-notification-tap.v1";
const PENDING_TAP_TTL_MS = 2 * 60 * 1000;

type ListenerHandle = { remove: () => Promise<void> };
type MessagingSource = {
  addListener: (
    event: "notificationActionPerformed",
    listener: (event: unknown) => void,
  ) => Promise<ListenerHandle>;
};
type AppStateSource = {
  getState: () => Promise<{ isActive: boolean }>;
  addListener: (
    event: "appStateChange",
    listener: (state: { isActive: boolean }) => void,
  ) => Promise<ListenerHandle>;
};
type ListenerLoaders = {
  messaging: () => Promise<MessagingSource>;
  app: () => Promise<AppStateSource>;
};

type PendingTap = { url: string; createdAt: number };
let registration: Promise<void> | null = null;

function internalPath(url: unknown): string | null {
  if (typeof window === "undefined" || typeof url !== "string" || !url.startsWith("/")) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return null;
  }
}

function readPendingTap(now = Date.now()): PendingTap | null {
  try {
    const raw = window.localStorage.getItem(PENDING_TAP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingTap>;
    const url = internalPath(parsed.url);
    if (!url || typeof parsed.createdAt !== "number" || now - parsed.createdAt > PENDING_TAP_TTL_MS) {
      window.localStorage.removeItem(PENDING_TAP_KEY);
      return null;
    }
    return { url, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

function storePendingTap(url: string): void {
  try {
    window.localStorage.setItem(PENDING_TAP_KEY, JSON.stringify({ url, createdAt: Date.now() }));
  } catch {
    // 저장소 차단 시 이동을 추측 실행하지 않는다. 다음 알림에서 다시 시도한다.
  }
}

function consumePendingTap(): void {
  const pending = readPendingTap();
  if (!pending) return;
  // 이동 전에 먼저 제거해 재활성화·reload에서 같은 탭이 재실행되지 않게 한다.
  window.localStorage.removeItem(PENDING_TAP_KEY);
  window.location.href = pending.url;
}

function storeTapEvent(event: unknown): void {
  const data = (event as { notification?: { data?: Record<string, unknown> } } | null)
    ?.notification?.data;
  const url = internalPath(data?.url);
  if (url) storePendingTap(url); // 최신 탭이 이전 탭을 덮는다.
}

async function attachListeners(loaders: ListenerLoaders): Promise<void> {
  const [messaging, app] = await Promise.all([loaders.messaging(), loaders.app()]);
  const appHandle = await app.addListener("appStateChange", ({ isActive }) => {
    if (isActive) consumePendingTap();
  });

  try {
    await messaging.addListener("notificationActionPerformed", (event) => {
      storeTapEvent(event);
      // callback 시점의 document 가시성을 추측하지 않고 네이티브 앱 상태를 직접 확인한다.
      void app.getState().then(({ isActive }) => {
        if (isActive) consumePendingTap();
      }).catch(() => undefined);
    });
  } catch (error) {
    await appHandle.remove().catch(() => undefined);
    throw error;
  }

  // callback 뒤 WebView reload가 있었거나 listener 부착 전에 플러그인이 retain한 이벤트도
  // localStorage의 최신 pending을 여기서 수렴시킨다.
  await app.getState().then(({ isActive }) => {
    if (isActive) consumePendingTap();
  }).catch(() => undefined);
}

const defaultLoaders: ListenerLoaders = {
  messaging: async () => (await import("@capacitor-firebase/messaging")).FirebaseMessaging,
  app: async () => (await import("@capacitor/app")).App,
};

/** NativePushMount에서 호출하는 실제 알림 탭 리스너 진입점. */
export async function listenForNotificationTap(loaders = defaultLoaders): Promise<void> {
  if (!isNativeRuntime()) return;
  if (!registration) {
    registration = attachListeners(loaders).catch(() => {
      registration = null; // 일시 실패 뒤 다음 mount/호출에서 재시도 가능
    });
  }
  await registration;
}

/** 테스트 전용 — 저장·등록 상태 초기화. */
export function __resetNotificationTapForTest(clearPending = true): void {
  registration = null;
  if (!clearPending) return;
  try {
    window.localStorage.removeItem(PENDING_TAP_KEY);
  } catch {
    // ignore
  }
}
