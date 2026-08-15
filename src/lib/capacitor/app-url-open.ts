"use client";

// appUrlOpen 단일 디스패처 (삼순 #1204 R2)
//
// 문제: Capacitor iOS는 retained `appUrlOpen`(cold launch로 앱이 열리기 전 도착한 URL)을
// *첫 리스너 등록 시 전달 후 삭제*한다. OAuth 리스너(capacitor/auth)와 LA 딥링크 재회수
// 리스너(native-push-deeplink)가 각자 App.addListener를 부르면, cold OAuth 복귀에서
// 어느 쪽이 먼저 붙느냐에 따라 다른 쪽이 이벤트를 영영 못 받는다(로그인 파손 가능).
//
// 해결: 네이티브 리스너는 이 모듈이 정확히 1개만 등록하고, 모든 소비자는 subscribe로
// 팬아웃받는다. 늦게 subscribe한 소비자에게는 이미 도착한 이벤트를 replay해
// "retained가 첫 리스너에서 소비돼 사라지는" 문제를 구조적으로 제거한다.

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

const subscribers: Subscriber[] = [];
// cold retained 이벤트 replay 버퍼 — late subscriber(OAuth 등)도 놓치지 않게 한다.
// URL 이벤트는 부팅 직후 소수만 발생하므로 작게 유지(oldest-out).
const REPLAY_MAX = 10;
const replayBuffer: UrlOpenEvent[] = [];
let attachPromise: Promise<void> | null = null;

function fanout(event: UrlOpenEvent): void {
  if (replayBuffer.length >= REPLAY_MAX) replayBuffer.shift();
  replayBuffer.push(event);
  for (const sub of [...subscribers]) {
    try {
      sub(event);
    } catch {
      // 한 소비자의 오류가 다른 소비자(OAuth ↔ 딥링크)를 막지 않는다
    }
  }
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

/**
 * appUrlOpen 구독 — 네이티브 리스너는 전 앱에서 이 모듈 1개만 등록된다.
 * 이미 도착한 이벤트(cold retained 포함)는 구독 즉시 replay로 전달된다.
 * 네이티브 등록 실패 시에도 구독 자체는 유지된다(다음 subscribe에서 재시도).
 */
export async function subscribeAppUrlOpen(subscriber: Subscriber): Promise<void> {
  subscribers.push(subscriber);
  for (const event of [...replayBuffer]) {
    try {
      subscriber(event);
    } catch {
      // subscriber 오류 격리
    }
  }
  if (!attachPromise) {
    attachPromise = (async () => {
      const app = await loadAppSource();
      await app.addListener("appUrlOpen", fanout);
    })().catch(() => {
      attachPromise = null; // 일시 실패 — 다음 subscribe에서 재시도
    });
  }
  await attachPromise;
}

/** 테스트 전용 — 구독/버퍼/등록 상태 초기화. */
export function __resetAppUrlOpenForTest(): void {
  subscribers.length = 0;
  replayBuffer.length = 0;
  attachPromise = null;
}
