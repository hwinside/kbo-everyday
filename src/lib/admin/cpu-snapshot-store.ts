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
    if (response.status === 404) return []; // 키 미존재 = 아직 적재 없음
    if (!response.ok) return null;
    const payload = (await response.json()) as { value?: unknown };
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
 * 스냅샷 배열 전체를 단일 upsert로 교체 (cron 전용 — 단일 작성자, 원자적 교체).
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
