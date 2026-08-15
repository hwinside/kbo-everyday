"use client";

// appUrlOpen 단일 디스패처 (삼순 #1204 R2·R3)
//
// R2 문제: Capacitor iOS는 retained `appUrlOpen`(cold launch로 앱이 열리기 전 도착한 URL)을
// *첫 리스너 등록 시 전달 후 삭제*한다. OAuth 리스너(capacitor/auth)와 LA 딥링크 재회수
// 리스너(native-push-deeplink)가 각자 App.addListener를 부르면, cold OAuth 복귀에서
// 어느 쪽이 먼저 붙느냐에 따라 다른 쪽이 이벤트를 영영 못 받는다(로그인 파손 가능).
// → 네이티브 리스너는 이 모듈이 정확히 1개만 등록하고, 소비자는 subscribe로 팬아웃받는다.
//
// R3-①: attach 실패를 "다음 subscribe 재시도"에만 맡기면 초기 소비자 2곳(OAuth·딥링크)이
// 전부 등록을 끝낸 뒤 실패했을 때 재시도 주체가 없어 앱 reload까지 영구 무수신이다.
// → 디스패처가 스스로 backoff 재시도한다(구독자가 남아 있는 한).
//
// R3-②: replay 버퍼는 OAuth 콜백의 code/access_token 등 secret URL을 담는다. 무기한
// 보관·전 구독자 재생은 유출면이다. → 이벤트는 구독자별 1회만 전달하고, 짧은 TTL(15초 —
// 부팅 창의 초기 구독자 등록만 커버) 후 즉시 폐기한다. late 구독자 replay는 부팅 창
// 안에서만 필요하므로 기능 손실이 없다.

type UrlOpenEvent = { url: string };
type Subscriber = (event: UrlOpenEvent) => void;

interface ListenerHandle { remove: () => Promise<void> }
interface AppUrlOpenSource {
  addListener: (
    event: "appUrlOpen",
    listener: (event: UrlOpenEvent) => void,
  ) => Promise<ListenerHandle>;
}
interface InjectedBridge { Plugins?: { App?: AppUrlOpenSource } }

interface BufferedEvent {
  event: UrlOpenEvent;
  expiresAt: number;
  deliveredTo: WeakSet<Subscriber>;
}

// secret URL 노출면 최소화 — 부팅 창(초기 구독자 2곳 등록)만 커버하면 된다.
const REPLAY_TTL_MS = 15_000;
const REPLAY_MAX = 10;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 15_000;

const subscribers: Subscriber[] = [];
const replayBuffer: BufferedEvent[] = [];
let attachPromise: Promise<void> | null = null;
let attached = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function now(): number {
  return Date.now();
}

/** 만료된 secret URL을 즉시 폐기한다(R3-②). 모든 진입점에서 호출. */
function sweepExpired(): void {
  const t = now();
  for (let i = replayBuffer.length - 1; i >= 0; i -= 1) {
    if (replayBuffer[i].expiresAt <= t) replayBuffer.splice(i, 1);
  }
}

function deliver(subscriber: Subscriber, buffered: BufferedEvent): void {
  if (buffered.deliveredTo.has(subscriber)) return; // 구독자별 1회 전달(R3-②)
  buffered.deliveredTo.add(subscriber);
  try {
    subscriber(buffered.event);
  } catch {
    // 한 소비자의 오류가 다른 소비자(OAuth ↔ 딥링크)를 막지 않는다
  }
}

function fanout(event: UrlOpenEvent): void {
  sweepExpired();
  if (replayBuffer.length >= REPLAY_MAX) replayBuffer.shift();
  const buffered: BufferedEvent = {
    event,
    expiresAt: now() + REPLAY_TTL_MS,
    deliveredTo: new WeakSet<Subscriber>(),
  };
  replayBuffer.push(buffered);
  for (const sub of [...subscribers]) deliver(sub, buffered);
}

async function loadAppSource(): Promise<AppUrlOpenSource> {
  // 원격 로드 dual-instance 우회 — 주입 브릿지 우선, 없으면 npm core.
  // (native-push-deeplink defaultLoaders와 동일 원칙; #484/#833 축)
  if (typeof window !== "undefined") {
    try {
      const injected = (window as unknown as { Capacitor?: InjectedBridge }).Capacitor?.Plugins?.App;
      if (injected) {
        return { addListener: (event, listener) => injected.addListener(event, listener) };
      }
    } catch {
      // bridge 접근 throw → npm fallback
    }
  }
  const { App } = await import("@capacitor/app");
  return { addListener: (event, listener) => App.addListener(event, listener) };
}

/** attach 실패 시 디스패처 자체 backoff 재시도(R3-①) — 구독자가 남아 있는 한 재연결한다. */
function scheduleRetry(): void {
  if (retryTimer !== null || attached) return;
  if (subscribers.length === 0) return; // 소비자가 없으면 다음 subscribe가 재시도 주체
  const delay = Math.min(RETRY_BASE_MS * 2 ** retryAttempt, RETRY_MAX_MS);
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void ensureAttached();
  }, delay);
}

function ensureAttached(): Promise<void> {
  if (attached) return Promise.resolve();
  if (!attachPromise) {
    attachPromise = (async () => {
      const app = await loadAppSource();
      await app.addListener("appUrlOpen", fanout);
      attached = true;
      retryAttempt = 0;
    })().catch(() => {
      attachPromise = null;
      scheduleRetry(); // 실패를 삼키되 재연결 책임은 디스패처가 진다(R3-①)
    });
  }
  return attachPromise;
}

/**
 * appUrlOpen 구독 — 네이티브 리스너는 전 앱에서 이 모듈 1개만 등록된다.
 * 부팅 창(TTL 15초) 내 이벤트는 late 구독자에게도 replay되며, 구독자별 1회만 전달되고
 * TTL 경과 시 즉시 폐기된다(secret URL 보존 금지). 네이티브 등록 실패 시에도 구독은
 * 유지되고 디스패처가 backoff로 스스로 재연결한다.
 */
export async function subscribeAppUrlOpen(subscriber: Subscriber): Promise<void> {
  subscribers.push(subscriber);
  sweepExpired();
  for (const buffered of [...replayBuffer]) deliver(subscriber, buffered);
  await ensureAttached();
}

/** 테스트 전용 — 구독/버퍼/등록/재시도 상태 초기화. */
export function __resetAppUrlOpenForTest(): void {
  subscribers.length = 0;
  replayBuffer.length = 0;
  attachPromise = null;
  attached = false;
  retryAttempt = 0;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}
