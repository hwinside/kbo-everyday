import type { CpuCounterSnapshot, StoredCpuSnapshot } from "@/lib/admin/system-health";

/**
 * CPU counter 스냅샷 저장소 — Vercel Edge Config (Supabase 밖).
 *
 * 삼순 리뷰(#1275 NO-GO) 반영:
 * - 감시 대상 Supabase DB에 원장을 두면 DB 장애 시 긴급 CPU 화면이 같이 무너지는
 *   순환 의존성이 생긴다 → 저장소를 Vercel Edge Config로 분리.
 * - health 경로는 읽기 전용(write 없음). 쓰기는 1분 cron 단일 작성자만 수행하고,
 *   전체 스냅샷 배열을 단일 upsert로 교체해 read→insert race 자체가 없다.
 * - 모든 네트워크 호출은 bounded timeout. 실패는 null(판정 불능)로 반환하고
 *   호출부는 즉시값만 비활성한 채 기존 클라이언트 60초 경로로 동작한다.
 *
 * 스토어: kbo-admin-metrics (id는 비밀 아님 — 접근에는 VERCEL_TOKEN 필요).
 */

export const EDGE_CONFIG_ID = "ecfg_grvkzbhpv3rmtyymi7z3akznsm8o";
export const EDGE_CONFIG_TEAM_ID = "team_8reKtsBJZRXGdVNEsD58gHCG";
export const CPU_SNAPSHOTS_KEY = "cpuSnapshots";
/** 유지 스냅샷 수 — 최신 + 직전 distinct tick 하나면 delta에 충분. */
export const CPU_SNAPSHOTS_KEEP = 2;

interface WireSnapshot {
  t: number; // capturedAt epoch ms
  fp: string;
  total: number;
  idle: number;
}

function itemUrl(): string {
  return `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/item/${CPU_SNAPSHOTS_KEY}?teamId=${EDGE_CONFIG_TEAM_ID}`;
}

function itemsUrl(): string {
  return `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items?teamId=${EDGE_CONFIG_TEAM_ID}`;
}

function token(): string | null {
  return process.env.VERCEL_TOKEN || null;
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

/**
 * 저장 스냅샷 조회 (읽기 전용).
 * 반환 계약: 성공 = 배열(빈 배열 = 아직 적재 없음), 실패/형 위반 = null (판정 불능 fail-close).
 */
export async function loadRecentCpuSnapshots(timeoutMs = 1_500): Promise<StoredCpuSnapshot[] | null> {
  const bearer = token();
  if (!bearer) return null;
  try {
    const response = await fetch(itemUrl(), {
      headers: { Authorization: `Bearer ${bearer}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 키 미존재 계약(실측): 404 또는 **204 No Content**(빈 본문) — 둘 다 "아직 적재 없음".
    // 204 에 response.json() 을 호출하면 예외가 나서 조회 실패로 오판되므로 먼저 걸러낸다.
    if (response.status === 404 || response.status === 204) return [];
    if (!response.ok) return null;
    const text = await response.text();
    if (text.trim() === "") return [];
    let payload: { value?: unknown };
    try {
      payload = JSON.parse(text) as { value?: unknown };
    } catch {
      return null;
    }
    const value = payload?.value;
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const rows: StoredCpuSnapshot[] = [];
    for (const raw of value) {
      const parsed = fromWire(raw);
      if (!parsed) return null; // 형 계약 위반 = 판정 불능
      rows.push(parsed);
    }
    return rows.sort((left, right) => right.capturedAtMs - left.capturedAtMs);
  } catch {
    return null;
  }
}

/**
 * 동시/중복 cron 실행에서도 최신값이 퇴행하지 않도록 병합하는 순수 함수 (삼순 3차 P1).
 *
 * Vercel 공식 계약상 cron은 중복·동시 실행될 수 있고 Edge Config PATCH에는 CAS가 없다.
 * 그래서 "읽은 값으로 통째 덮어쓰기" 대신 **단조 병합**을 한다:
 * - 기존 + 신규를 합치고 counter identity로 dedupe
 * - capturedAt 내림차순 정렬 후 상위 keep개만 유지
 * - 결과의 최신 counter가 기존 최신보다 뒤로 가면(total 감소) 기존을 유지
 *   → 느린 작업자의 stale write가 최신값을 덮어쓰지 못한다.
 */
export function mergeCpuSnapshots(
  existing: StoredCpuSnapshot[],
  incoming: StoredCpuSnapshot,
  keep = CPU_SNAPSHOTS_KEEP,
): StoredCpuSnapshot[] {
  const identity = (row: StoredCpuSnapshot) =>
    `${row.seriesFingerprint}|${row.totalSeconds}|${row.idleSeconds}`;
  const byIdentity = new Map<string, StoredCpuSnapshot>();
  for (const row of [incoming, ...existing]) {
    const key = identity(row);
    const seen = byIdentity.get(key);
    // 같은 counter가 여러 번 적재됐으면 가장 이른 관측 시각을 유지(rate 창을 과소평가하지 않기 위해).
    if (!seen || row.capturedAtMs < seen.capturedAtMs) byIdentity.set(key, row);
  }
  const merged = [...byIdentity.values()].sort((left, right) => right.capturedAtMs - left.capturedAtMs);

  const previousNewest = [...existing].sort((left, right) => right.capturedAtMs - left.capturedAtMs)[0];
  const nextNewest = merged[0];
  if (
    previousNewest &&
    nextNewest &&
    nextNewest.seriesFingerprint === previousNewest.seriesFingerprint &&
    nextNewest.totalSeconds < previousNewest.totalSeconds
  ) {
    return existing.slice(0, keep); // 퇴행 방지 — stale writer 무시
  }
  return merged.slice(0, keep);
}

/**
 * 스냅샷 배열 전체를 단일 upsert로 교체 (cron 전용).
 * health 경로에서 호출 금지.
 */
export async function replaceCpuSnapshots(
  snapshots: StoredCpuSnapshot[],
  timeoutMs = 3_000,
): Promise<boolean> {
  const bearer = token();
  if (!bearer) return false;
  try {
    const response = await fetch(itemsUrl(), {
      method: "PATCH",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            operation: "upsert",
            key: CPU_SNAPSHOTS_KEY,
            value: snapshots.slice(0, CPU_SNAPSHOTS_KEEP).map(toWire),
          },
        ],
      }),
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
 * cron 적재 종단: read → 단조 병합 → PATCH → **재조회 검증**.
 * 동시 실행으로 내 쓰기가 덮였거나 최신값이 퇴행했으면 병합을 다시 시도한다(최대 attempts회).
 * 성공 기준: 최종 상태의 최신 counter가 내 스냅샷 이상(total ≥)이면 OK
 * (다른 작업자가 더 최신값을 썼으면 그것도 성공으로 본다 — 목표는 내 쓰기가 아니라 신선도다).
 */
export async function commitCpuSnapshot(
  incoming: StoredCpuSnapshot,
  attempts = 3,
): Promise<{ ok: boolean; wrote: boolean }> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const existing = await loadRecentCpuSnapshots();
    if (existing === null) return { ok: false, wrote: false };

    const newest = existing[0] ?? null;
    if (
      newest &&
      newest.seriesFingerprint === incoming.seriesFingerprint &&
      newest.totalSeconds >= incoming.totalSeconds
    ) {
      return { ok: true, wrote: false }; // 이미 동일하거나 더 최신이다
    }

    const merged = mergeCpuSnapshots(existing, incoming);
    if (!(await replaceCpuSnapshots(merged))) continue;

    const verified = await loadRecentCpuSnapshots();
    if (verified === null) continue;
    const verifiedNewest = verified[0] ?? null;
    if (
      verifiedNewest &&
      verifiedNewest.seriesFingerprint === incoming.seriesFingerprint &&
      verifiedNewest.totalSeconds >= incoming.totalSeconds
    ) {
      return { ok: true, wrote: true };
    }
    // 동시 실행이 덮어써 퇴행함 — 재시도
  }
  return { ok: false, wrote: false };
}
