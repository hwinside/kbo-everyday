import type { CpuCounterSnapshot, StoredCpuSnapshot } from "@/lib/admin/system-health";

/**
 * admin_metric_snapshots 접근 계층 (service role 전용 테이블).
 *
 * Supabase 메트릭 scrape가 ~60초 주기라 브라우저 단독으로는 첫 ~60초 동안
 * CPU busy%를 계산할 수 없다(#1266 QA 회귀 → #1270). 서버가 1분 cron과
 * health API 호출 시점에 counter 스냅샷을 적재해두면, 대시보드를 여는 즉시
 * 직전 스냅샷과의 delta로 값을 표시할 수 있다.
 *
 * 계약:
 * - 조회/저장 실패는 이 기능의 실패일 뿐 health API의 실패가 아니다 →
 *   호출부는 null/false를 받고 기존(클라이언트 60초 baseline) 경로로 동작한다.
 * - 저장은 counter가 실제로 전진했을 때만 (같은 scrape tick 중복 적재 방지).
 */

const TABLE = "admin_metric_snapshots";
export const SNAPSHOT_RETENTION_MINUTES = 60;

interface SnapshotRow {
  captured_at: string;
  fingerprint: string;
  total_seconds: number;
  idle_seconds: number;
}

async function adminClient() {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  return supabaseAdmin;
}

/** 최근 스냅샷을 최신순으로 읽는다. 실패 시 null (빈 배열과 구분 — 조회 실패를 "없음"으로 오독 금지). */
export async function loadRecentCpuSnapshots(limit = 10): Promise<StoredCpuSnapshot[] | null> {
  try {
    const supabase = await adminClient();
    const { data, error } = await supabase
      .from(TABLE)
      .select("captured_at,fingerprint,total_seconds,idle_seconds")
      .order("captured_at", { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return null;
    const rows: StoredCpuSnapshot[] = [];
    for (const raw of data as SnapshotRow[]) {
      const capturedAtMs = Date.parse(raw.captured_at);
      if (
        !Number.isFinite(capturedAtMs) ||
        typeof raw.fingerprint !== "string" ||
        !Number.isFinite(raw.total_seconds) ||
        !Number.isFinite(raw.idle_seconds)
      ) {
        return null; // 형 계약 위반 = 판정 불능 (fail-close)
      }
      rows.push({
        capturedAtMs,
        seriesFingerprint: raw.fingerprint,
        totalSeconds: raw.total_seconds,
        idleSeconds: raw.idle_seconds,
      });
    }
    return rows;
  } catch {
    return null;
  }
}

/**
 * counter가 최신 저장분 대비 전진했을 때만 insert.
 * latestStored가 null(조회 실패/빈 원장)이면 무조건 insert (첫 적재).
 */
export async function storeCpuSnapshotIfAdvanced(
  current: CpuCounterSnapshot,
  latestStored: StoredCpuSnapshot | null,
  capturedAt: Date,
): Promise<boolean> {
  if (
    latestStored &&
    latestStored.seriesFingerprint === current.seriesFingerprint &&
    latestStored.totalSeconds === current.totalSeconds &&
    latestStored.idleSeconds === current.idleSeconds
  ) {
    return false; // 같은 scrape tick — 적재 불필요
  }
  try {
    const supabase = await adminClient();
    const { error } = await supabase.from(TABLE).insert({
      captured_at: capturedAt.toISOString(),
      fingerprint: current.seriesFingerprint,
      total_seconds: current.totalSeconds,
      idle_seconds: current.idleSeconds,
    });
    return !error;
  } catch {
    return false;
  }
}

/** 보존 기간을 지난 스냅샷 정리 (cron 전용). */
export async function pruneCpuSnapshots(now: Date): Promise<boolean> {
  try {
    const supabase = await adminClient();
    const cutoff = new Date(now.getTime() - SNAPSHOT_RETENTION_MINUTES * 60_000).toISOString();
    const { error } = await supabase.from(TABLE).delete().lt("captured_at", cutoff);
    return !error;
  } catch {
    return false;
  }
}
