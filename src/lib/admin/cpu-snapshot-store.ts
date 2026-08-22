import { createHash } from "node:crypto";
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
 * 동시성 (삼순 5차 P1 반영 — non-overwrite append):
 * Vercel 공식 계약상 cron은 중복·동시 실행될 수 있고 Edge Config PATCH에는 CAS가 없다.
 * - 4차 설계(독립 key + upsert)는 같은 key의 LWW upsert라 동일 counter 중복 cron이
 *   value의 capturedAt을 퇴행시킬 수 있었고, 32-bit FNV로는 "다른 counter = 다른 key"를
 *   구조적으로 보장하지 못했다(삼순 5차 지적).
 * - → 쓰기를 **`create` 전용**으로 바꾼다: 한 번 쓰인 key는 불변(immutable). 늦은
 *   write는 create 실패로 끝나므로 이미 저장된 스냅샷의 어떤 필드도(시각 포함)
 *   바꿀 수 없다 — LWW 퇴행 경로 자체가 없다. 양방향(새→옛 / 옛→새) 어느 순서로
 *   중복 write가 와도 최종 저장 상태는 "먼저 쓰인 값 그대로"다.
 * - key = `cpuSnap_<sha256(counter identity) 32hex>` — 128-bit digest로 "다른 counter =
 *   다른 key"를 보장(32-bit FNV 충돌 지적 해소). 시각버킷은 넣지 않는다(삼순 가이드) —
 *   버킷이 있으면 분 경계의 동일 counter 중복 cron이 다른 key로 남아 최신 2개가 동일
 *   tick이 되고 유효한 baseline을 가릴 수 있다. 같은 counter는 언제 쓰든 같은 key로
 *   수렴 → 중복 cron은 두 번째 create 실패 = 멱등, 저장값은 첫 write 불변이므로
 *   최종 freshness가 write 순서와 무관하게 유지된다.
 * - sha256 충돌(사실상 불가)이 실제로 나도 create는 남의 key를 덮지 못하고 실패한다.
 *   commit은 verify에서 identity 불일치를 감지하면 **별도 폴백 key**로 append한다
 *   — 어떤 경우에도 기존 항목 덮어쓰기는 발생하지 않는다.
 * - GC는 "자기 나이 기준 10분 초과" 항목만 best-effort 삭제 — 신선한 key는
 *   어떤 interleaving에서도 삭제 대상이 될 수 없다.
 *
 * 스토어: kbo-admin-metrics (id는 비밀 아님 — 접근에는 VERCEL_TOKEN 필요).
 */

export const EDGE_CONFIG_ID = "ecfg_grvkzbhpv3rmtyymi7z3akznsm8o";
export const EDGE_CONFIG_TEAM_ID = "team_8reKtsBJZRXGdVNEsD58gHCG";
/** 스냅샷 독립 key prefix — `cpuSnap_<identity sha256 32hex>` */
export const CPU_SNAPSHOT_KEY_PREFIX = "cpuSnap_";
/** 구 설계(단일 배열 key) 잔재 — GC에서 발견 시 함께 제거한다. */
export const CPU_SNAPSHOTS_LEGACY_KEY = "***";
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

function identityOf(snapshot: {
  seriesFingerprint: string;
  totalSeconds: number;
  idleSeconds: number;
}): string {
  return `${snapshot.seriesFingerprint}|${snapshot.totalSeconds}|${snapshot.idleSeconds}`;
}

/**
 * counter identity → 독립 key (시각 무관 — 삼순 가이드: 시각버킷 금지).
 * 같은 counter를 잡은 중복 cron은 언제 쓰든 같은 key로 수렴한다(두 번째 create는
 * 실패=멱등, 저장값은 첫 write 불변). 다른 counter는 128-bit digest로 다른 key가
 * 보장된다. 만에 하나 충돌해도 create는 덮어쓰기가 아니라 실패하고, commit이
 * verify에서 identity 불일치를 보고 폴백 key로 우회한다.
 */
export function cpuSnapshotKey(snapshot: {
  seriesFingerprint: string;
  totalSeconds: number;
  idleSeconds: number;
}): string {
  const digest = createHash("sha256").update(identityOf(snapshot)).digest("hex").slice(0, 32);
  return `${CPU_SNAPSHOT_KEY_PREFIX}${digest}`;
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
 * 같은 counter identity가 여러 key에 있으면(버킷 경계를 걸친 중복 cron) 가장 이른
 * 관측 시각 하나로 dedupe한다 → 최종 freshness가 write 순서와 무관하게 결정적이고,
 * rate 창을 과소평가하지 않는다.
 * 반환 계약: 성공 = capturedAt 내림차순 배열(빈 배열 = 아직 적재 없음), 실패 = null.
 */
export async function loadRecentCpuSnapshots(timeoutMs = 1_500): Promise<StoredCpuSnapshot[] | null> {
  const items = await loadStoredCpuItems(timeoutMs);
  if (items === null) return null;
  const byIdentity = new Map<string, StoredCpuSnapshot>();
  for (const item of items) {
    const key = identityOf(item.snapshot);
    const seen = byIdentity.get(key);
    if (!seen || item.snapshot.capturedAtMs < seen.capturedAtMs) byIdentity.set(key, item.snapshot);
  }
  return [...byIdentity.values()].sort((left, right) => right.capturedAtMs - left.capturedAtMs);
}

async function patchItems(
  operations: Array<{ operation: "create" | "delete"; key: string; value?: WireSnapshot }>,
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
 * cron 적재 종단 (non-overwrite append — 삼순 5차 P1):
 * 1) 내 스냅샷을 **`create` 전용**으로 자기 key에 append — 이미 존재하는 key는 어떤
 *    경우에도 수정되지 않는다(불변). stale write의 시각 퇴행이 구조적으로 불가능.
 * 2) 재조회 검증 — 내 key의 실재와 identity 일치를 확인한다.
 *    - identity 일치: 성공(내가 썼거나, 같은 샘플을 잡은 중복 cron이 먼저 씀 = 멱등).
 *    - identity 불일치(해시 충돌로 다른 counter가 선점): 기존 항목을 건드리지 않고
 *      **폴백 key**(`_c<n>` suffix)로 append를 재시도한다.
 * 3) GC(best-effort) — 자기 나이 10분 초과 key + 레거시 배열 key만 삭제.
 *    실패해도 적재 성공 판정에는 영향 없음(다음 주기에 재시도된다).
 */
export async function commitCpuSnapshot(
  incoming: StoredCpuSnapshot,
  attempts = 3,
): Promise<{ ok: boolean; wrote: boolean }> {
  const baseKey = cpuSnapshotKey(incoming);
  let collisionSuffix = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const key = collisionSuffix === 0 ? baseKey : `${baseKey}_c${collisionSuffix}`;
    const created = await patchItems([{ operation: "create", key, value: toWire(incoming) }]);

    const verified = await loadStoredCpuItems();
    if (verified === null) continue;
    const mine = verified.find((item) => item.key === key);
    if (mine) {
      if (identityOf(mine.snapshot) !== identityOf(incoming)) {
        // sha256 충돌로 다른 counter가 이 key를 선점 — 기존 항목은 불변으로 두고 폴백 key로 우회
        collisionSuffix += 1;
        continue;
      }
      // GC: 자기 나이 기준으로만 후보 선정 — 어떤 interleaving에서도 신선한 key는 후보가 못 된다.
      const now = Date.now();
      const expired = verified
        .filter((item) => now - item.snapshot.capturedAtMs > CPU_SNAPSHOT_GC_AGE_MS)
        .map((item) => ({ operation: "delete" as const, key: item.key }));
      if (expired.length > 0) {
        await patchItems(expired); // best-effort
      }
      await patchItems([{ operation: "delete", key: CPU_SNAPSHOTS_LEGACY_KEY }]).catch(() => false);
      return { ok: true, wrote: created };
    }
    // create 실패 + 키 부재 = 일시 오류 → 재시도
  }
  return { ok: false, wrote: false };
}
