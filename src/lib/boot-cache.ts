// 부트 번들(/api/me/boot) 클라 캐시 — PR④ per-user 부트 fanout 다이어트.
//
// AuthContext 의 프로필 로드(1차)가 /api/me/boot 로 profile+prefs+gameChatVisible 을
// 한 번에 받아 여기 심고, 부트 직후에 각자 fetch 하던 소비자들이
// (native-live-activity 게이트 · Android 잠금카드 게이트 · game-chat 노출 훅)
// 짧은 TTL 안에서 1회씩 꺼내 쓴다.
//
// 계약:
// - userId 결속: 꺼낼 때 현재 세션 userId 가 일치해야 한다 (계정 전환 오염 방지).
// - TTL 60s: 부트 창 밖에서는 절대 재사용하지 않는다 (타기기 변경 반영 지연 상한).
// - consume-once: 슬라이스별 1회 소비 — 이후 마운트/재시도는 기존 fetch 경로 그대로.
// - fail-open: 캐시 미스면 소비자는 종전 fetch 를 그대로 탄다 (동작 계약 불변).
// - 토글(PUT) 성공 시 invalidateBootCache() — 부트 창 내 토글 직후 stale 적용 방지.
import type { NotificationPrefs } from "@/lib/notifications/prefs";

const BOOT_CACHE_TTL_MS = 60 * 1000;

interface BootCacheData {
  userId: string;
  prefs: NotificationPrefs | null;
  gameChatVisible: boolean | null;
  at: number;
}

type BootSlice = "liveActivityGate" | "androidLockCardGate" | "gameChatVisible";

let cache: BootCacheData | null = null;
let consumed: Set<BootSlice> = new Set();

export function setBootCache(data: { userId: string; prefs: NotificationPrefs | null; gameChatVisible: boolean | null }): void {
  cache = { ...data, at: Date.now() };
  consumed = new Set();
}

export function invalidateBootCache(): void {
  cache = null;
  consumed = new Set();
}

function takeFresh(userId: string, slice: BootSlice): BootCacheData | null {
  if (!cache) return null;
  if (cache.userId !== userId) return null;
  if (Date.now() - cache.at > BOOT_CACHE_TTL_MS) return null;
  if (consumed.has(slice)) return null;
  consumed.add(slice);
  return cache;
}

/** prefs 슬라이스 1회 소비 (null = 미스 → 종전 fetch로). */
export function takeBootPrefs(userId: string, slice: "liveActivityGate" | "androidLockCardGate"): NotificationPrefs | null {
  return takeFresh(userId, slice)?.prefs ?? null;
}

/** game-chat 노출값 1회 소비 (null = 미스 → 종전 fetch로). */
export function takeBootGameChatVisible(userId: string): boolean | null {
  const hit = takeFresh(userId, "gameChatVisible");
  if (!hit) return null;
  return hit.gameChatVisible;
}
