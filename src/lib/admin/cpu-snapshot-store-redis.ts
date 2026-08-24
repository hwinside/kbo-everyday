import type { StoredCpuSnapshot } from "@/lib/admin/system-health";
import {
  counterAdvanced,
  loadRecentCpuSnapshots as loadLegacyEdgeConfigSnapshots,
} from "@/lib/admin/cpu-snapshot-store";

/**
 * CPU counter snapshot store — Upstash Redis REST.
 *
 * Why a sorted set:
 * - one immutable member per counter identity; `ZADD NX` prevents duplicate cron
 *   executions from moving an existing sample's timestamp forward or backward;
 * - the score is the first observed timestamp, so reads remain deterministically ordered;
 * - GC is bounded to this key and removes only entries older than the retention window.
 *
 * Rollout safety:
 * - writes never fall back to Edge Config;
 * - while Redis credentials are absent, reads may use the existing Edge Config data so
 *   the P0 stop and P1 credential rollout can be deployed independently. Once Redis is
 *   configured, Redis failures return null and the existing client 60-second delta path
 *   takes over (fail closed).
 */

export { counterAdvanced };

export const CPU_SNAPSHOT_REDIS_KEY = "kbo:admin:cpu-snapshots:v1";
export const CPU_SNAPSHOT_RETENTION_MS = 10 * 60_000;

interface RedisMember {
  fp: string;
  total: number;
  idle: number;
}

interface RedisResponse {
  result?: unknown;
  error?: unknown;
}

function config(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

function memberOf(snapshot: {
  seriesFingerprint: string;
  totalSeconds: number;
  idleSeconds: number;
}): string {
  return JSON.stringify({
    fp: snapshot.seriesFingerprint,
    total: snapshot.totalSeconds,
    idle: snapshot.idleSeconds,
  } satisfies RedisMember);
}

function parseMember(raw: unknown, score: unknown): StoredCpuSnapshot | null {
  if (typeof raw !== "string") return null;
  const capturedAtMs = typeof score === "number" ? score : Number(score);
  if (!Number.isFinite(capturedAtMs)) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const member = value as Partial<RedisMember>;
  if (
    typeof member.fp !== "string" ||
    typeof member.total !== "number" ||
    !Number.isFinite(member.total) ||
    typeof member.idle !== "number" ||
    !Number.isFinite(member.idle)
  ) {
    return null;
  }
  return {
    capturedAtMs,
    seriesFingerprint: member.fp,
    totalSeconds: member.total,
    idleSeconds: member.idle,
  };
}

async function command(args: Array<string | number>, timeoutMs: number): Promise<unknown | null> {
  const redis = config();
  if (!redis) return null;
  try {
    const response = await fetch(redis.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redis.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as RedisResponse;
    if (payload.error !== undefined || !("result" in payload)) return null;
    return payload.result;
  } catch {
    return null;
  }
}

/**
 * Read-only health-path lookup. Success returns newest-first rows; malformed provider
 * output is a failure (null), never an empty-store success.
 */
export async function loadRecentCpuSnapshots(timeoutMs = 1_500): Promise<StoredCpuSnapshot[] | null> {
  if (!config()) return loadLegacyEdgeConfigSnapshots(timeoutMs);

  const now = Date.now();
  const result = await command(
    ["ZRANGEBYSCORE", CPU_SNAPSHOT_REDIS_KEY, now - CPU_SNAPSHOT_RETENTION_MS, "+inf", "WITHSCORES"],
    timeoutMs,
  );
  if (!Array.isArray(result) || result.length % 2 !== 0) return null;

  const snapshots: StoredCpuSnapshot[] = [];
  for (let index = 0; index < result.length; index += 2) {
    const parsed = parseMember(result[index], result[index + 1]);
    if (!parsed) return null;
    snapshots.push(parsed);
  }
  return snapshots.sort((left, right) => right.capturedAtMs - left.capturedAtMs);
}

/**
 * Cron write endpoint. `ZADD NX` makes the full counter identity immutable and
 * idempotent; a duplicate sample does not refresh its timestamp. GC is best-effort
 * after a successful append/idempotent hit and cannot delete fresh rows.
 */
export async function commitCpuSnapshot(
  incoming: StoredCpuSnapshot,
): Promise<{ ok: boolean; wrote: boolean }> {
  if (!config()) return { ok: false, wrote: false };

  const added = await command(
    ["ZADD", CPU_SNAPSHOT_REDIS_KEY, "NX", incoming.capturedAtMs, memberOf(incoming)],
    3_000,
  );
  if (added !== 0 && added !== 1) return { ok: false, wrote: false };

  await command(
    ["ZREMRANGEBYSCORE", CPU_SNAPSHOT_REDIS_KEY, "-inf", Date.now() - CPU_SNAPSHOT_RETENTION_MS],
    3_000,
  );
  return { ok: true, wrote: added === 1 };
}
