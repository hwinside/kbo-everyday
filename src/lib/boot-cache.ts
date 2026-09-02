// 부트 번들(/api/me/boot) 클라 캐시 — PR④ per-user 부트 fanout 다이어트 (v3).
//
// AuthContext 의 프로필 로드(1차)가 /api/me/boot 로 profile(+네이티브면 prefs)을
// 한 번에 받아 여기 심고, 부트 직후 각자 /api/push/prefs 를 fetch 하던 네이티브
// 소비자들(iOS LA 게이트 · Android 잠금카드 게이트)이 부트 로드 완료를 기다렸다가
// 값을 1회씩 꺼내 쓴다. game-chat 노출은 profile.game_chat_enabled 파생(훅)이라
// 이 캐시를 쓰지 않는다.
//
// v2→v3 (삼순 #1332 2차 NO-GO 반영):
// - grace 는 "최초 boot 시작 전" 상태에서만: 한 번이라도 begin 이 있었으면(=부트가
//   이미 지나갔으면) begin 대기 없이 즉시 fallback — late 소비자(경기방 진입 등)가
//   매번 5초를 기다리는 지연 제거.
// - pending generation 결속: invalidateBootCache()·로그아웃·연속 begin(force-load)이
//   기존 pending 을 supersede-resolve 한다. 구 settle 은 세대 불일치로 무시되어
//   로그아웃/토글 뒤 옛 응답이 캐시를 재생성하지 못하고, 구 waiter 는 즉시 풀려
//   fallback 한다(10초 결박 제거).
//
// 계약:
// - beginBootLoad(userId): AuthContext 가 부트 fetch 시작 직전에 호출. 반환된
//   세대 토큰을 settleBootLoad 에 그대로 전달한다.
// - settleBootLoad(token, prefs|null): 응답 도착(null = 실패/prefs 미포함 → 소비자
//   fail-open). token 세대가 현재와 다르면 무시(superseded 응답).
// - awaitBootPrefs(userId, slice): ①fresh 캐시 즉시 소비 ②pending 이 있으면 settle
//   대기(같은 userId 만) ③pending 이 없고 최초 begin 전이면 begin 유예 후 재시도
//   ④그 외 즉시 null(fallback).
// - userId 결속 · TTL 60s · 슬라이스별 consume-once · fail-open 은 v1 계약 그대로.
import type { NotificationPrefs } from "@/lib/notifications/prefs";

const BOOT_CACHE_TTL_MS = 60 * 1000;
const BEGIN_GRACE_MS = 5 * 1000; // 소비자 선행 → 최초 begin 대기 상한 (최초 boot 전에만)
const SETTLE_TIMEOUT_MS = 10 * 1000; // begin 후 응답 대기 상한 (느린 네트워크 fail-open)

export type BootPrefsSlice = "liveActivityGate" | "androidLockCardGate";

export interface BootLoadToken {
  userId: string;
  generation: number;
}

interface BootCacheEntry {
  userId: string;
  prefs: NotificationPrefs | null;
  at: number;
}

interface PendingBoot {
  userId: string;
  generation: number;
  promise: Promise<void>;
  resolve: () => void;
}

let generationCounter = 0;
let everBegan = false; // 최초 boot 관측 여부 — grace 허용 판단
let cache: BootCacheEntry | null = null;
let consumed: Set<BootPrefsSlice> = new Set();
let pending: PendingBoot | null = null;
let beginWaiters: Array<() => void> = [];

function notifyBegin(): void {
  const waiters = beginWaiters;
  beginWaiters = [];
  for (const w of waiters) w();
}

function supersedePending(): void {
  if (pending) {
    pending.resolve(); // 구 waiter 즉시 해제 → takeFresh 미스로 fallback
    pending = null;
  }
}

/** AuthContext: /api/me/boot fetch 시작 직전 호출. 반환 토큰을 settle 에 넘긴다.
 *  연속 호출(force-load)은 기존 pending 을 supersede 한다. */
export function beginBootLoad(userId: string): BootLoadToken {
  supersedePending();
  everBegan = true;
  generationCounter += 1;
  const generation = generationCounter;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  pending = { userId, generation, promise, resolve };
  notifyBegin();
  return { userId, generation };
}

/** AuthContext: 부트 응답 도착/실패 시 호출. prefs null = 미포함/실패 (소비자 fail-open).
 *  세대가 다르면(그 사이 invalidate/재begin) 응답을 버린다 — 옛 settle 의 캐시 재생성 차단. */
export function settleBootLoad(token: BootLoadToken, prefs: NotificationPrefs | null): void {
  if (!pending || pending.generation !== token.generation || pending.userId !== token.userId) {
    return; // superseded — 캐시/대기자에 영향 없음
  }
  pending.resolve();
  pending = null;
  cache = { userId: token.userId, prefs, at: Date.now() };
  consumed = new Set();
}

/** 로그아웃·no-session·토글 반영 시 호출 — 캐시 폐기 + in-flight pending supersede.
 *  이후 도착하는 옛 settle 은 세대 불일치로 무시된다. */
export function invalidateBootCache(): void {
  cache = null;
  consumed = new Set();
  supersedePending();
}

function takeFresh(userId: string, slice: BootPrefsSlice): NotificationPrefs | null {
  if (!cache) return null;
  if (cache.userId !== userId) return null;
  if (Date.now() - cache.at > BOOT_CACHE_TTL_MS) return null;
  if (consumed.has(slice)) return null;
  consumed.add(slice);
  return cache.prefs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForBegin(timeoutMs: number): Promise<boolean> {
  if (pending) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    beginWaiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** 네이티브 소비자용 — 부트 로드를 기다렸다가 prefs 슬라이스를 1회 소비.
 *  null = 미스(비로그인·타임아웃·실패·TTL 초과·이미 소비·late 진입) → 종전 fetch 폴백.
 *  grace 대기는 "최초 begin 전" 상태에서만 — 부트가 이미 지나간 late 소비자는 즉시
 *  fallback 한다(5초 지연 제거, 삼순 2차 NO-GO). 모든 대기 경로 종착지는 takeFresh
 *  재시도다(begin 직후 동기 settle 시 pending 소실 — 게이트 P1 실측 결함). */
export async function awaitBootPrefs(userId: string, slice: BootPrefsSlice): Promise<NotificationPrefs | null> {
  // ① 이미 정착한 fresh 캐시
  const immediate = takeFresh(userId, slice);
  if (immediate) return immediate;
  if (cache && cache.userId === userId && consumed.has(slice)) return null; // 재소비/실패 정착 — 폴백

  // ② begin 대기 — 최초 boot 전(everBegan=false)에만 grace 허용.
  //    부트가 이미 지나갔다면(late 소비자) 기다리지 않고 즉시 fallback.
  if (!pending) {
    if (everBegan) return null;
    const begun = await waitForBegin(BEGIN_GRACE_MS);
    if (!begun) return takeFresh(userId, slice); // 그레이스 중 동기 settle 재확인
  }
  // ③ pending snapshot — settle/supersede 가 pending 을 리셋하므로 잡아둔다.
  const p = pending;
  if (p) {
    if (p.userId !== userId) return null; // 다른 계정 부트는 기다리지 않는다
    const settled = await Promise.race([p.promise.then(() => true), sleep(SETTLE_TIMEOUT_MS).then(() => false)]);
    if (!settled) return null; // 느린 네트워크 fail-open
  }
  // ④ 종착지: begin~지금 사이 settle 됐다면 여기서 잡힌다 (supersede 였다면 미스 → fallback)
  return takeFresh(userId, slice);
}

/** QA 전용 — 모듈 상태 전체 리셋 (게이트 시나리오 격리). 프로덕션 코드는 호출하지 않는다. */
export function __qaResetBootCache(): void {
  generationCounter = 0;
  everBegan = false;
  cache = null;
  consumed = new Set();
  pending = null;
  beginWaiters = [];
}
