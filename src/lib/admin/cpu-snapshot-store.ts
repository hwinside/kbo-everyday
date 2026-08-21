import type { CpuCounterSnapshot, StoredCpuSnapshot } from "@/lib/admin/system-health";

/**
 * CPU counter 스냅샷 저장소 — Vercel Edge Config (Supabase 밖).
 *
 * 삼순 리뷰(#1275 NO-GO) 반영:
 * - 감시 대상 Supabase DB에 원장을 두면 DB 장애 시 긴급 CPU 화면이 같이 무너지는
 *   순환 의존성이 생긴다 → 저장소를 Vercel Edge Config로 분리.
 * - health 경로는 읽기 전용(write 없음). 쓰기는 1분 cron만 수행한다.
 * - 모든 네트워크 호출은 bounded timeout. 실패는 null(판정 불능)로 반환하고
 *   호출부는 즉시값만 비활성한 채 기존 클라이언트 60초 경로로 동작한다.
 *
 * 동시성 (삼순 4차 P1 반영 — 독립 key append 설계):
 * Vercel 공식 계약상 cron은 중복·동시 실행될 수 있고 Edge Config PATCH에는 CAS가 없다.
 * 종전 "단일 배열 key를 read→merge→PATCH"는 read/read/write(D)/write(C) interleaving에서
 * 느린 작업자 C의 stale write가 D를 되돌릴 수 있었다(삼순 반례).
 * → 공유 배열 key를 폐기하고 **스냅샷 1개 = 독립 key 1개**로 append한다.
 *   - key는 counter identity(fingerprint|total|idle)의 해시로 결정론 생성:
 *     같은 샘플을 쓰는 중복 cron은 같은 key에 동일 값을 upsert(멱등)하고,
 *     다른 샘플을 쓰는 작업자끼리는 key가 달라 **서로의 값을 원리적으로 덮을 수 없다**.
 *   - 쓰기에 read-modify-write 자체가 없으므로 stale read로 인한 퇴행이 구조적으로 소멸.
 *   - 최신 판정은 읽기 시점에 값의 capturedAt 정렬로 수행한다.
 *   - GC는 "자기 나이 기준 10분 초과" 항목만 best-effort 삭제 — 신선한 key는
 *     어떤 interleaving에서도 삭제 대상이 될 수 없다.
 *
 * 스토어: kbo-admin-metrics (id는 비밀 아님 — 접근에는 VERCEL_TOKEN 필요).
 */

export const EDGE_CONFIG_ID = "ecfg_grvkzbhpv3rmtyymi7z3akznsm8o";
export const EDGE_CONFIG_TEAM_ID = "team_8reKtsBJZRXGdVNEsD58gHCG";
/** 스냅샷 독립 key prefix — `cpuSnap_<identity hash>` */
export const CPU_SNAPSHOT_KEY_PREFIX = "cpuSnap_";
/** 구 설계(단일 배열 key) 잔재 — GC에서 발견 시 함께 제거한다. */
export const CPU_SNAPSHOTS_LEGACY_KEY = "cpuSnapshots";
/** 유지 스냅샷 수 — 최신 + 직전 distinct tick 하나면 delta에 충분. */
export const CPU_SNAPSHOTS_KEEP = 2;
/** GC 기준 나이 — 이보다 오래된 스냅샷 key만 삭제 후보(신선 key 오삭제 원리적 차단). */
export const CPU_SNAPSHOT_GC_AGE_MS = 10 * 60_000;

interface WireSnapshot {
  t: number; // capturedAt epoch ms
  fp: string;
  total: number;
  idle: number;
}

function itemsUrl(): string {
  return `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items?teamId=${EDGE_CONFIG_TEAM_ID}`;
}

function token(): string | null {
  return process.env.VERCEL_TOKEN || null;
}

/** 32-bit FNV-1a — counter identity를 결정론적 key로 접는다(비밀 아님, 충돌 시에도 값 계약은 동일 샘플). */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** counter identity → 독립 key. 같은 샘플이면 항상 같은 key(중복 cron 멱등). */
export function cpuSnapshotKey(snapshot: {
  seriesFingerprint: string;
  totalSeconds: number;
  idleSeconds: number;
}): string {
  return `${CPU_SNAPSHOT_KEY_PREFIX}${fnv1aHex(
    `${snapshot.seriesFingerprint}|${snapshot.totalSeconds}|${snapshot.idleSeconds}`,
  )}`;
}

function toWire(snapshot: StoredCpuSnapshot): WireSnapshot {
  return {
    t: snapshot.capturedAtMs,
    fp: snapshot.seriesFingerprint,
    total: snapshot.totalSeconds,
    idle: snapshot.idleSeconds,
  };
}

function fromWire(raw: unknown): StoredCpuSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const wire = raw as Partial<WireSnapshot>;
  if (
    typeof wire.t !== "number" ||
    !Number.isFinite(wire.t) ||
    typeof wire.fp !== "string" ||
    typeof wire.total !== "number" ||
    !Number.isFinite(wire.total) ||
    typeof wire.idle !== "number" ||
    !Number.isFinite(wire.idle)
  ) {
    return null;
  }
  return {
    capturedAtMs: wire.t,
    seriesFingerprint: wire.fp,
    totalSeconds: wire.total,
    idleSeconds: wire.idle,
  };
}

interface StoredCpuItem {
  key: string;
  snapshot: StoredCpuSnapshot;
}

/**
 * 저장 스냅샷 항목 전체 조회 (읽기 전용, key 포함 — GC/검증용).
 * 반환 계약: 성공 = 배열(빈 배열 = 아직 적재 없음), 실패/형 위반 = null (판정 불능 fail-close).
 * `cpuSnap_` prefix가 아닌 key(레거시 배열 key 포함)는 값 계약 판정에서 제외한다.
 */
export async function loadStoredCpuItems(timeoutMs = 1_500): Promise<StoredCpuItem[] | null> {
  const bearer = token();
  if (!bearer) return null;
  try {
    const response = await fetch(itemsUrl(), {
      headers: { Authorization: `Bearer ${bearer}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 빈 스토어 계약(실측 — 단일 item 조회에서 검증): 404 또는 **204 No Content**(빈 본문).
    // 204에 response.json()을 호출하면 예외가 나서 조회 실패로 오판되므로 먼저 걸러낸다.
    if (response.status === 404 || response.status === 204) return [];
    if (!response.ok) return null;
    const text = await response.text();
    if (text.trim() === "") return [];
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return null;
    }
    // /items 응답: [{ key, value, ... }] 배열. (방어적으로 { key: value } map 형태도 수용)
    const entries: Array<{ key: unknown; value: unknown }> = [];
    if (Array.isArray(payload)) {
      for (const raw of payload) {
        if (typeof raw !== "object" || raw === null) return null;
        entries.push({ key: (raw as { key?: unknown }).key, value: (raw as { value?: unknown }).value });
      }
    } else if (typeof payload === "object" && payload !== null) {
      for (const [key, value] of Object.entries(payload)) entries.push({ key, value });
    } else {
      return null;
    }
    const items: StoredCpuItem[] = [];
    for (const entry of entries) {
      if (typeof entry.key !== "string") return null;
      if (!entry.key.startsWith(CPU_SNAPSHOT_KEY_PREFIX)) continue; // 레거시/타 key 무시
      const parsed = fromWire(entry.value);
      if (!parsed) return null; // 형 계약 위반 = 판정 불능
      items.push({ key: entry.key, snapshot: parsed });
    }
    return items.sort((left, right) => right.snapshot.capturedAtMs - left.snapshot.capturedAtMs);
  } catch {
    return null;
  }
}

/**
 * 저장 스냅샷 조회 (읽기 전용, health 경로 사용).
 * 반환 계약: 성공 = capturedAt 내림차순 배열(빈 배열 = 아직 적재 없음), 실패 = null.
 */
export async function loadRecentCpuSnapshots(timeoutMs = 1_500): Promise<StoredCpuSnapshot[] | null> {
  const items = await loadStoredCpuItems(timeoutMs);
  if (items === null) return null;
  return items.map((item) => item.snapshot);
}

async function patchItems(
  operations: Array<{ operation: "upsert" | "delete"; key: string; value?: WireSnapshot }>,
  timeoutMs = 3_000,
): Promise<boolean> {
  const bearer = token();
  if (!bearer) return false;
  try {
    const response = await fetch(itemsUrl(), {
      method: "PATCH",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ items: operations }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** cron용: counter가 최신 저장분 대비 전진했는지 판정 (동일 scrape tick 중복 적재 방지). */
export function counterAdvanced(
  current: CpuCounterSnapshot,
  latestStored: StoredCpuSnapshot | null,
): boolean {
  if (!latestStored) return true;
  return (
    latestStored.seriesFingerprint !== current.seriesFingerprint ||
    latestStored.totalSeconds !== current.totalSeconds ||
    latestStored.idleSeconds !== current.idleSeconds
  );
}

/**
 * cron 적재 종단 (독립 key append — 삼순 4차 P1):
 * 1) 내 스냅샷을 **자기 key에만** upsert — 다른 작업자의 key를 읽지도 쓰지도 않으므로
 *    stale read 기반 퇴행(read/read/write(D)/write(C))이 구조적으로 불가능하다.
 * 2) 재조회 검증 — 내 key가 실제 저장됐는지 확인(전송 성공 ≠ 반영 아님).
 * 3) GC(best-effort) — 자기 나이 10분 초과 key + 레거시 배열 key만 삭제.
 *    실패해도 적재 성공 판정에는 영향 없음(다음 주기에 재시도된다).
 */
export async function commitCpuSnapshot(
  incoming: StoredCpuSnapshot,
  attempts = 2,
): Promise<{ ok: boolean; wrote: boolean }> {
  const key = cpuSnapshotKey(incoming);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await patchItems([{ operation: "upsert", key, value: toWire(incoming) }]))) continue;

    const verified = await loadStoredCpuItems();
    if (verified === null) continue;
    const mine = verified.find((item) => item.key === key);
    if (!mine) continue; // 전송은 성공했지만 반영 확인 실패 — 재시도

    // GC: 자기 나이 기준으로만 후보 선정 — 어떤 interleaving에서도 신선한 key는 후보가 못 된다.
    const now = Date.now();
    const expired = verified
      .filter((item) => now - item.snapshot.capturedAtMs > CPU_SNAPSHOT_GC_AGE_MS)
      .map((item) => ({ operation: "delete" as const, key: item.key }));
    if (expired.length > 0) {
      await patchItems(expired); // best-effort
    }
    await patchItems([{ operation: "delete", key: CPU_SNAPSHOTS_LEGACY_KEY }]).catch(() => false);
    return { ok: true, wrote: true };
  }
  return { ok: false, wrote: false };
}
