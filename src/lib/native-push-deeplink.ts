"use client";

import { registerPlugin } from "@capacitor/core";
import { classifyAppUrlOpen, subscribeAppUrlOpen } from "@/lib/capacitor/app-url-open";
import { isNativeRuntime } from "@/lib/capacitor/platform";

// 알림 탭 → 앱 내 딥링크 이동 (iOS/Android 네이티브 전용).
//
// 실패 모드 2축을 하나의 pending 저장소로 수렴시킨다:
// 1) background 탭 (#1070): 콜백이 background 컨텍스트에서 실행되면 window.location 이동이
//    유실/부분실행될 수 있다 → pending을 localStorage에 저장하고 appStateChange(active)에서 소비.
// 2) cold-start 탭 (#1198): 앱이 완전 종료된 상태에서 탭하면 웹뷰/브릿지가 아직 없어 JS
//    notificationActionPerformed 자체가 유실될 수 있다 → AppDelegate가 launchOptions의 url을
//    UserDefaults에 stash(1.0.14+), 부팅 후 PushDeepLink.consume()으로 회수해 같은 저장소에 합류.
//
// 소비는 단일 경로(consumePendingTap) 1회 — 이동 전 키 제거 + 현재 페이지와 동일하면 no-op라
// cold native pending과 retained JS 이벤트가 같은 탭을 이중 전달해도 이동은 1회다.

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
type PushDeepLinkSource = {
  consume: () => Promise<{ url?: string }>;
};
type ListenerLoaders = {
  messaging: () => Promise<MessagingSource>;
  app: () => Promise<AppStateSource>;
  /** 네이티브 cold-start stash 회수(1.0.14+). 구빌드/미탑재는 loader가 throw → silent no-op. */
  pushDeepLink: () => Promise<PushDeepLinkSource>;
  /**
   * appUrlOpen 구독 — 반드시 단일 디스패쳐(subscribeAppUrlOpen)를 경유한다.
   * App.addListener 직접 등록은 cold retained 이벤트를 OAuth 리스너와 경합시킨다(삼순 #1204 R2).
   */
  urlOpen: (listener: (event: { url: string }) => void) => Promise<void>;
};

type PendingTap = { url: string; createdAt: number };
let registration: Promise<void> | null = null;
// 직전 소비한 딥링크 — 같은 부팅에서 cold-start 네이티브 stash 와 retained JS 이벤트가
// 같은 탭을 이중 전달해도 이동은 1회여야 한다. 실제 브라우저에서 location 변경은
// 비동기라 pathname 비교만으로는 경합을 닫지 못해 짧은 시간창 가드를 둔다.
// 유저가 나중에 같은 알림을 다시 탭하는 경우는 창을 벗어나 정상 이동한다.
const DUPLICATE_NAV_WINDOW_MS = 5_000;
let lastConsumedUrl: string | null = null;
let lastConsumedAt = 0;

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
  const now = Date.now();
  // 중복 이동 0 — 같은 URL을 방금 소비했으면 재이동하지 않는다
  // (cold native pending ↔ retained JS 이벤트 동시 전달 경합).
  if (lastConsumedUrl === pending.url && now - lastConsumedAt <= DUPLICATE_NAV_WINDOW_MS) return;
  // 이미 해당 페이지면 no-op — 이동 완료 후 재mount로 같은 pending이 다시 들어오는 경우.
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (pending.url === current) return;
  lastConsumedUrl = pending.url;
  lastConsumedAt = now;
  window.location.href = pending.url;
}

function storeTapEvent(event: unknown): void {
  const data = (event as { notification?: { data?: Record<string, unknown> } } | null)
    ?.notification?.data;
  const url = internalPath(data?.url);
  if (url) storePendingTap(url); // 최신 탭이 이전 탭을 덮는다.
}

/**
 * appUrlOpen 이벤트 URL → LA 딥링크 내부 경로. la-deeplink 분류가 아니면 null.
 *
 * widgetURL 은 절대 URL(https://keubo.fan/games/<id>)로 온다 — internalPath 는
 * 내부 경로("/"로 시작)만 받으므로 origin 검증 후 pathname 으로 내린 다음 통과시킨다.
 */
function laDeepLinkPathFromEvent(event: unknown): string | null {
  const url = (event as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || url.length === 0) return null;
  // 폐쇄 분류 — la-deeplink 가 아닌 것(OAuth callback·unknown)은 여기서 다루지 않는다.
  if (classifyAppUrlOpen(url) !== "la-deeplink") return null;
  try {
    const parsed = new URL(url);
    // 웹뷰 origin 과 다른 호스트는 거부(외부 유입 차단).
    if (typeof window !== "undefined" && parsed.origin !== window.location.origin) return null;
    return internalPath(parsed.pathname + parsed.search + parsed.hash);
  } catch {
    return null;
  }
}

/** cold-start 네이티브 stash 회수 → 같은 pending 저장소에 합류. 구빌드/실패는 silent no-op. */
async function consumeNativePendingIntoStore(loaders: ListenerLoaders): Promise<void> {
  try {
    const plugin = await loaders.pushDeepLink();
    const { url } = await plugin.consume();
    const path = internalPath(url);
    if (path) storePendingTap(path);
  } catch {
    // 구빌드(플러그인 미탑재)/브릿지 오류 — 딥링크는 부가 기능, 앱 동작 무영향
  }
}

async function attachListeners(loaders: ListenerLoaders): Promise<void> {
  const [messaging, app] = await Promise.all([loaders.messaging(), loaders.app()]);
  const appHandle = await app.addListener("appStateChange", ({ isActive }) => {
    if (!isActive) return;
    // warm 복귀 — 백그라운드에 있는 동안 네이티브 stash가 새로 생겼을 수 있다
    // (Live Activity 카드 탭 → AppDelegate continue가 stash). 재회수 후 소비.
    void consumeNativePendingIntoStore(loaders).then(() => consumePendingTap());
  });

  // 순서 역전 방어(삼순 #1204 R1-①) — iOS는 continue(stash)와 appStateChange(active)의
  // 순서를 계약하지 않는다. active가 먼저 오면 위 핸들러는 빈손으로 끝나 stash가 잔류한다.
  // AppDelegate는 stash를 proxy 호출 '전'에 실행하므로, Capacitor가 그 뒤 발행하는
  // appUrlOpen 시점에는 stash 존재가 보장된다 → 이 이벤트를 재회수 트리거로 쓴다.
  // 단일 디스패쳐 구독(R2) — OAuth 리스너와 네이티브 리스너를 경합시키지 않는다.
  //
  // 🔴 실기기 QA(2026-08-15 build 25) — 잠금화면 LA 카드 탭이 여전히 미이동.
  // 이 리스너가 이벤트 URL 을 버리고 "AppDelegate 가 stash 해둔다"는 가정하에 네이티브
  // stash 재조회만 했던 것이 원인. widgetURL 은 iOS 버전·컨텍스트에 따라
  //   (a) continue(userActivity:) — AppDelegate 가 stash ✅
  //   (b) open(url:)          — stash 없음 ❌ → 재조회 빈손 → 아무 일도 안 일어남
  // 두 경로 중 어느 쪽으로 오든 닫히도록, 이벤트 URL 자체를 1차 근거로 쓰고
  // stash 재조회는 그대로 유지한다(순서 역전 방어 R1-① 계약 보존).
  // 분류는 단일 디스패처의 폐쇄 분류(classifyAppUrlOpen)를 재사용 — la-deeplink 가
  // 아닌 URL(OAuth callback 등)은 여기서 저장하지 않는다(세션 교환 플로우 보호).
  await loaders.urlOpen((event) => {
    const direct = laDeepLinkPathFromEvent(event);
    if (direct) storePendingTap(direct);
    void consumeNativePendingIntoStore(loaders)
      .then(() => app.getState())
      .then(({ isActive }) => {
        if (isActive) consumePendingTap();
      })
      .catch(() => undefined);
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

  // cold-start 네이티브 stash를 pending에 합류시킨 뒤(#1198), listener 부착 전 retained
  // 이벤트·WebView reload로 남은 localStorage pending과 함께 여기서 1회 수렴시킨다(#1070).
  await consumeNativePendingIntoStore(loaders);
  await app.getState().then(({ isActive }) => {
    if (isActive) consumePendingTap();
  }).catch(() => undefined);
}

interface InjectedPluginsBridge {
  Plugins?: Record<string, unknown>;
}

/**
 * 원격 로드(server.url) dual-instance 우회 — 주입 브릿지의 플러그인 인스턴스를 먼저 찾는다.
 *
 * npm 번들과 앱에 주입된 window.Capacitor 는 서로 다른 인스턴스다. npm core 가 'web' 으로
 * 오판하는 설치 앱(#484/#833 축)에서 npm 모듈을 쓰면 **Web 구현**에 listener 가 붙어
 * 네이티브 탭 이벤트를 영원히 못 받는다(#1070 background 실패의 또 하나의 원인 후보).
 */
function injectedPlugin<T>(name: string): T | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const plugin = (window as unknown as { Capacitor?: InjectedPluginsBridge })
      .Capacitor?.Plugins?.[name];
    return plugin ? (plugin as T) : undefined;
  } catch {
    return undefined; // bridge 접근 throw → npm fallback
  }
}

const defaultLoaders: ListenerLoaders = {
  // ⚠️ Capacitor plugin proxy 를 async 함수에서 그대로 return 하지 않는다 — await 의 thenable
  // 검사가 proxy 의 .then 을 네이티브 호출로 변환해 "X.then() is not implemented" 런타임
  // 에러가 난다(native-push.ts 상단 사고 사례). 메서드만 노출하는 객체로 감싼다.
  messaging: async () => {
    const injected = injectedPlugin<MessagingSource>("FirebaseMessaging");
    if (injected) {
      return { addListener: (event, listener) => injected.addListener(event, listener) };
    }
    const { FirebaseMessaging } = await import("@capacitor-firebase/messaging");
    return {
      addListener: (event, listener) =>
        FirebaseMessaging.addListener(event, listener as (e: unknown) => void),
    } as MessagingSource;
  },
  app: async () => {
    const injected = injectedPlugin<AppStateSource>("App");
    if (injected) {
      return {
        getState: () => injected.getState(),
        addListener: (event, listener) => injected.addListener(event, listener),
      };
    }
    const { App } = await import("@capacitor/app");
    return {
      getState: () => App.getState(),
      addListener: (event, listener) => App.addListener(event, listener),
    } as AppStateSource;
  },
  urlOpen: (listener) => subscribeAppUrlOpen("la-deeplink", listener),
  pushDeepLink: async () => {
    // 주입 브릿지 우선, 없으면 npm core registerPlugin
    // (구빌드는 호출 시 unimplemented throw → 상위 catch no-op).
    const injected = injectedPlugin<PushDeepLinkSource>("PushDeepLink");
    const plugin = injected ?? registerPlugin<PushDeepLinkSource>("PushDeepLink");
    return { consume: () => plugin.consume() };
  },
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
  lastConsumedUrl = null;
  lastConsumedAt = 0;
  if (!clearPending) return;
  try {
    window.localStorage.removeItem(PENDING_TAP_KEY);
  } catch {
    // ignore
  }
}
