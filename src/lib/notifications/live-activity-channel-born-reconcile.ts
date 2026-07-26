export const CHANNEL_BORN_RECONCILE_LIMIT = 1_000;
export const CHANNEL_BORN_RECONCILE_TIMEOUT_MS = 5_000;

export interface ChannelBornReconcileMetrics {
  ok: boolean;
  activeGenerations: number;
  eligible: number;
  healed: number;
  hasMore: boolean;
  durationMs: number;
  error?: string;
}

interface ReconcileRow {
  active_generations: number;
  eligible: number;
  healed: number;
  has_more: boolean;
}

/**
 * 현재 active 채널 세대와 정확히 일치하는 네이티브 ACK가 있는 미마킹 카드만 회수한다.
 *
 * DB RPC가 active 채널 행을 share-lock한 한 statement 안에서 ACK 검증과 UPDATE를
 * 수행하므로 채널 회전과 경합해도 구세대를 새 마킹으로 기록하지 않는다. 호출은 매분
 * warmup fanout과 병렬로 시작되며, 이 함수의 실패가 APNs/FCM 발송을 막지 않는다.
 */
export async function reconcileChannelBornFromAcks(opts?: {
  limit?: number;
  timeoutMs?: number;
  now?: () => number;
  execute?: (
    limit: number,
    signal: AbortSignal,
  ) => PromiseLike<{ data: ReconcileRow[] | null; error: { message: string } | null }>;
}): Promise<ChannelBornReconcileMetrics> {
  const limit = Math.min(
    CHANNEL_BORN_RECONCILE_LIMIT,
    Math.max(1, Math.trunc(opts?.limit ?? CHANNEL_BORN_RECONCILE_LIMIT)),
  );
  const timeoutMs = Math.min(
    CHANNEL_BORN_RECONCILE_TIMEOUT_MS,
    Math.max(1, Math.trunc(opts?.timeoutMs ?? CHANNEL_BORN_RECONCILE_TIMEOUT_MS)),
  );
  const now = opts?.now ?? (() => Date.now());
  const startedAt = now();
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const result = opts?.execute
      ? await opts.execute(limit, signal)
      : await (async () => {
          const { supabaseAdmin } = await import("@/lib/supabase/admin");
          // query-guard: bounded -- RPC returns exactly one metrics row; writes are capped to p_limit≤1000 in SQL.
          return supabaseAdmin
            .rpc("reconcile_live_activity_channel_born", { p_limit: limit })
            .abortSignal(signal);
        })();
    if (result.error) throw new Error(result.error.message);
    const row = (result.data?.[0] ?? null) as ReconcileRow | null;
    if (!row) throw new Error("reconcile RPC returned no metrics");
    return {
      ok: true,
      activeGenerations: Number(row.active_generations),
      eligible: Number(row.eligible),
      healed: Number(row.healed),
      hasMore: Boolean(row.has_more),
      durationMs: Math.max(0, now() - startedAt),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[live-activity] channel_born reconcile failed: ${message}`);
    return {
      ok: false,
      activeGenerations: 0,
      eligible: 0,
      healed: 0,
      hasMore: false,
      durationMs: Math.max(0, now() - startedAt),
      error: message,
    };
  }
}
