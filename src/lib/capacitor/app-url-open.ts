"use client";

// appUrlOpen 단일 디스패처 (삼순 #1204 R2·R3·R4)
//
// R2 문제: Capacitor iOS는 retained `appUrlOpen`(cold launch로 앱이 열리기 전 도착한 URL)을
// *첫 리스너 등록 시 전달 후 삭제*한다. OAuth 리스너(capacitor/auth)와 LA 딥링크 재회수
// 리스너(native-push-deeplink)가 각자 App.addListener를 부르면, cold OAuth 복귀에서
// 어느 쪽이 먼저 붙느냐에 따라 다른 쪽이 이벤트를 영영 못 받는다(로그인 파손 가능).
// → 네이티브 리스너는 이 모듈이 정확히 1개만 등록하고, 소비자는 subscribe로 팬아웃받는다.
//
// R3-①: attach 실패는 디스패처가 backoff로 스스로 재연결한다(재구독 없이 복구).
//
// R4 (R3-② 고정 TTL의 두 결함 교정):
// - 고정 15초 컷오프는 느린 remote-load OAuth 구독자가 15초를 넘겨 붙으면 R2의
//   cold OAuth 유실을 그대로 재발시킨다 → 시간이 아니라 **소비자 기준**으로 보관한다.
// - sweep이 subscribe/fanout 진입 때만 돌면 이후 진입이 없을 때 secret URL이 메모리에
//   잔류한다 → orphan은 **실제 expiry timer**(setTimeout)로 추가 진입 없이 자동 폐기한다.
//
// R5 (보관 대상의 폐쇄 분류): 모든 URL을 전 소비자 pending으로 잡으면 OAuth가 이미
// 처리한 secret이 무관한 LA 소비자를 기다리며 최대 60초 잔류한다. 이벤트는 도착
// 즉시 폐쇄 분류해 **해당 소비자만** pending에 넣는다: OAuth callback→oauth,
// exact /games/<id>→la-deeplink. 분류 불가(unknown)는 replay 없이 fail-closed(보관 0·전달 0).
//
// 보관 계약: 이벤트는 분류된 relevant 소비자가 1회 수신할 때까지만 보관하고,
// 수신 즉시 버퍼에서 삭제한다(secret 즉시 폐기). 끝내 안 붙는 소비자의 이벤트는
// orphan timer(60초)가 제거한다.

type UrlOpenEvent = { url: string };
type Subscriber = (event: UrlOpenEvent) => void;

/** 폐쇄집합 — 이 디스패처를 소비하는 앱 내 소비자 ID. 새 소비자는 여기와 classifyAppUrlOpen에 추가해야 replay를 보장받는다. */
export type AppUrlOpenConsumerId = "oauth" | "la-deeplink";

// LA 카드 widgetURL이 만드는 exact 경로 — AppDelegate continue의 stash allowlist와 동일 형상.
const LA_GAMES_PATH_RE = /^\/games\/[A-Za-z0-9]{1,32}$/;

/**
 * 이벤트의 relevant 소비자를 폐쇄 분류한다(삼순 R5).
 * - oauth: OAuth callback 표식이 있는 URL만 — code query · token hash · /auth 경로 · auth error 파라미터.
 * - la-deeplink: exact /games/<id> (LA widgetURL → 네이티브 stash 재회수 트리거).
 * - null: 분류 불가 — 보관도 전달도 하지 않는다(fail-closed).
 */
export function classifyAppUrlOpen(url: string): AppUrlOpenConsumerId | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null; // 파싱 불가 URL은 fail-closed
  }
  if (parsed.pathname.startsWith("/auth")) return "oauth";
  if (parsed.searchParams.has("code") || parsed.searchParams.has("error")) return "oauth";
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  if (hashParams.has("access_token") || hashParams.has("refresh_token") || hashParams.has("error")) {
    return "oauth";
  }
  if (LA_GAMES_PATH_RE.test(parsed.pathname)) return "la-deeplink";
  return null;
}

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
  /** 아직 이 이벤트를 받지 못한 expected 소비자 — 비는 즉시 이벤트 삭제. */
  pending: Set<AppUrlOpenConsumerId>;
  /** orphan 자동 폐기 타이머 — 추가 진입 없이도 secret이 메모리에 남지 않게 한다(R4). */
  expiryTimer: ReturnType<typeof setTimeout>;
}

// orphan(끝내 안 붙는 소비자 대기분) 보관 상한. OAuth code 수명과 부팅 지연을 함께 고려.
let orphanTtlMs = 60_000;
const REPLAY_MAX = 10;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 15_000;

const subscribers = new Map<AppUrlOpenConsumerId, Subscriber[]>();
const replayBuffer: BufferedEvent[] = [];
let attachPromise: Promise<void> | null = null;
let attached = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function dropBuffered(buffered: BufferedEvent): void {
  clearTimeout(buffered.expiryTimer);
  const idx = replayBuffer.indexOf(buffered);
  if (idx !== -1) replayBuffer.splice(idx, 1);
}

function deliver(consumerId: AppUrlOpenConsumerId, subscriber: Subscriber, buffered: BufferedEvent): void {
  if (!buffered.pending.has(consumerId)) return; // 소비자별 1회 — 재구독/재마운트 중복 재생 0
  buffered.pending.delete(consumerId);
  if (buffered.pending.size === 0) dropBuffered(buffered); // 마지막 대기 소비자 수신 → secret 즉시 폐기(R4)
  try {
    subscriber(buffered.event);
  } catch {
    // 한 소비자의 오류가 다른 소비자(OAuth ↔ 딥링크)를 막지 않는다
  }
}

function fanout(event: UrlOpenEvent): void {
  const relevant = classifyAppUrlOpen(event.url);
  if (relevant === null) return; // unknown — replay 없이 fail-closed(보관 0·전달 0)
  if (replayBuffer.length >= REPLAY_MAX) dropBuffered(replayBuffer[0]);
  const buffered: BufferedEvent = {
    event,
    pending: new Set([relevant]), // relevant 소비자만 대기 — 무관 소비자 때문에 secret이 잔류하지 않는다(R5)
    expiryTimer: setTimeout(() => dropBuffered(buffered), orphanTtlMs),
  };
  replayBuffer.push(buffered);
  const subs = subscribers.get(relevant);
  if (subs && subs.length > 0) {
    deliver(relevant, subs[0], buffered); // 같은 ID의 첫 구독자가 대표 수신(ID당 1회 계약) → 수신 즉시 buffer 0
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

function subscriberCount(): number {
  let n = 0;
  for (const subs of subscribers.values()) n += subs.length;
  return n;
}

/** attach 실패 시 디스패처 자체 backoff 재시도(R3-①) — 구독자가 남아 있는 한 재연결한다. */
function scheduleRetry(): void {
  if (retryTimer !== null || attached) return;
  if (subscriberCount() === 0) return; // 소비자가 없으면 다음 subscribe가 재시도 주체
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
 * 대기 중인 이벤트는 이 consumerId가 아직 수신하지 않은 것만 즉시 전달되며(1회),
 * 마지막 대기 소비자가 수신하는 순간 이벤트(secret URL 포함)는 버퍼에서 삭제된다.
 * 어떤 소비자도 끝내 붙지 않은 이벤트는 orphan expiry timer가 자동 폐기한다.
 * 네이티브 등록 실패 시에도 구독은 유지되고 디스패처가 backoff로 스스로 재연결한다.
 */
export async function subscribeAppUrlOpen(
  consumerId: AppUrlOpenConsumerId,
  subscriber: Subscriber,
): Promise<void> {
  const subs = subscribers.get(consumerId) ?? [];
  subs.push(subscriber);
  subscribers.set(consumerId, subs);
  for (const buffered of [...replayBuffer]) deliver(consumerId, subscriber, buffered);
  await ensureAttached();
}

/** 테스트 전용 — 구독/버퍼/등록/재시도 상태 초기화. */
export function __resetAppUrlOpenForTest(): void {
  subscribers.clear();
  for (const buffered of [...replayBuffer]) dropBuffered(buffered);
  attachPromise = null;
  attached = false;
  retryAttempt = 0;
  orphanTtlMs = 60_000;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/** 테스트 전용 — orphan expiry 관찰용 훅. */
export function __appUrlOpenBufferSizeForTest(): number {
  return replayBuffer.length;
}
export function __setAppUrlOpenOrphanTtlForTest(ms: number): void {
  orphanTtlMs = ms;
}
