// 부트 번들(/api/me/boot) 클라 캐시 — PR④ per-user 부트 fanout 다이어트 (v2).
//
// AuthContext 의 프로필 로드(1차)가 /api/me/boot 로 profile(+네이티브면 prefs)을
// 한 번에 받아 여기 심고, 부트 직후 각자 /api/push/prefs 를 fetch 하던 네이티브
// 소비자들(iOS LA 게이트 · Android 잠금카드 게이트)이 부트 로드 완료를 "기다렸다가"
// 값을 1회씩 꺼내 쓴다. game-chat 노출은 profile.game_chat_enabled 파생으로 이동해
// 이 캐시를 쓰지 않는다.
//
// v2 핵심(삼순 NO-GO ① 반영): 소비자가 먼저 떠도 절감이 성립해야 한다.
// NativePushMount 는 AuthProvider 보다 먼저 마운트되므로(layout.tsx 107 vs 109)
// 단순 look-aside 캐시는 race 로 미스 → 종전 fetch 가 그대로 나간다. 그래서
// begin/settle 2단 프로토콜 + awaitBootPrefs(begin 유예 → settle 대기)로
// "부트 로드가 곧 시작될" 창을 소비자가 기다린다.
//
// 계약:
// - beginBootLoad(userId): AuthContext 가 부트 fetch 시작 직전에 호출.
// - settleBootLoad(userId, prefs|null): 응답 도착(null = 실패/prefs 미포함 → 소비자 fail-open).
// - awaitBootPrefs(userId, slice): ①fresh 캐시 즉시 소비 ②같은 userId pending 이면
//   settle 대기(상한) ③pending 이 아직 없으면 begin 유예(상한) 후 재시도 ④미스 = null.
// - userId 결속: 다른 계정의 begin/settle/캐시는 절대 소비하지 않는다 (계정 전환 오염 방지).
// - TTL 60s: 부트 창 밖(늦은 소비)은 재사용하지 않는다 (타기기 변경 반영 지연 상한).
// - consume-once: 슬라이스별 1회 소비 — 이후 재시도는 기존 fetch 경로 그대로.
// - fail-open: 미스/실패/타임아웃이면 소비자는 종전 fetch 를 그대로 탄다 (동작 계약 불변).
// - 토글(PUT) 반영·로그아웃·no-session 시 invalidateBootCache().
import type { NotificationPrefs } from "@/lib/notifications/prefs";

const BOOT_CACHE_TTL_MS = 60 * 1000;
const BEGIN_GRACE_MS = 5 * 1000; // 소비자 선행 → AuthContext begin 대기 상한
const SETTLE_TIMEOUT_MS = 10 * 1000; // begin 후 응답 대기 상한 (느린 네트워크 fail-open)

export type BootPrefsSlice = "liveActivityGate" | "androidLockCardGate";

interface BootCacheEntry {
  userId: string;
  prefs: NotificationPrefs | null;
  at: number;
}

interface PendingBoot {
  userId: string;
  promise: Promise<void>;
  resolve: () => void;
}

let cache: BootCacheEntry | null = null;
let consumed: Set<BootPrefsSlice> = new Set();
let pending: PendingBoot | null = null;
let beginWaiters: Array<() => void> = [];

function notifyBegin(): void {
  const waiters = beginWaiters;
  beginWaiters = [];
  for (const w of waiters) w();
}

/** AuthContext: /api/me/boot fetch 시작 직전 호출. */
export function beginBootLoad(userId: string): void {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  pending = { userId, promise, resolve };
  notifyBegin();
}

/** AuthContext: 부트 응답 도착/실패 시 호출. prefs null = 미포함/실패 (소비자 fail-open). */
export function settleBootLoad(userId: string, prefs: NotificationPrefs | null): void {
  if (pending?.userId === userId) {
    pending.resolve();
    pending = null;
  }
  cache = { userId, prefs, at: Date.now() };
  consumed = new Set();
}

export function invalidateBootCache(): void {
  cache = null;
  consumed = new Set();
  // pending 은 유지 — in-flight 부트 로드의 settle 이 새 값을 다시 심는다.
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
 *  null = 미스(비로그인·타임아웃·실패·TTL 초과·이미 소비) → 호출자는 종전 fetch 로 폴백.
 *  주의: begin 직후 동기로 settle 이 떨어지면 대기 재개 시점에 pending 이 이미 없다 —
 *  그래서 모든 대기 경로의 종착지는 항상 takeFresh 재시도다 (qa:user-boot-bundle P1 실측 결함). */
export async function awaitBootPrefs(userId: string, slice: BootPrefsSlice): Promise<NotificationPrefs | null> {
  // ① 이미 정착한 fresh 캐시
  const immediate = takeFresh(userId, slice);
  if (immediate) return immediate;
  if (cache && cache.userId === userId && consumed.has(slice)) return null; // 재소비/실패 정착 — 폴백

  // ② begin 대기 (소비자가 AuthContext 보다 먼저 뜨는 race 흡수).
  //    그레이스 타임아웃이어도 그사이 settle 이 내려앉았을 수 있으므로 마지막에 재시도.
  if (!pending) {
    const begun = await waitForBegin(BEGIN_GRACE_MS);
    if (!begun) return takeFresh(userId, slice);
  }
  // ③ pending snapshot — settle 이 pending 을 null 로 리셋하므로 반드시 잡아둔다.
  const p = pending;
  if (p) {
    if (p.userId !== userId) return null; // 다른 계정 부트는 기다리지 않는다
    const settled = await Promise.race([p.promise.then(() => true), sleep(SETTLE_TIMEOUT_MS).then(() => false)]);
    if (!settled) return null; // 느린 네트워크 fail-open
  }
  // ④ 종착지: begin~지금 사이 언젠가 settle 됐다면 여기서 잡힌다
  return takeFresh(userId, slice);
}
