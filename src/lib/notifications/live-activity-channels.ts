import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { apnsConfigured, getProviderTokenSafe } from "@/lib/notifications/apns";
import {
  createBroadcastChannel,
  deleteBroadcastChannel,
  sendBroadcastPush,
  type ApnsEnvironment,
} from "@/lib/notifications/apns-broadcast";
import {
  decideChannelPush,
  scoreStateOf,
  fullStateHashOf,
  endRetryDelayMinutes,
  CHANNEL_END_RETENTION_MS,
} from "@/lib/notifications/live-activity-channel-policy";
import {
  buildLiveActivityContentState,
  liveActivityGameStatus,
  liveActivityStartWindow,
} from "@/lib/notifications/live-activity";
import type { KboRawGame } from "@/types/api";

// Broadcast 채널 lifecycle (스펙 v4 §서버) — warmup cron(매분)에서 호출.
//  1. ensureLiveActivityChannels: start 윈도우 진입 경기에 env별 채널 생성(멱등)
//  2. pushLiveActivityChannelBroadcasts: 라이브 = update broadcast(priority 10/5/스킵),
//     종료·취소 = end broadcast + backoff 재시도, 8h 후 채널 DELETE, 스테일 sweep
// 구독 기기(iOS18+·빌드16+)는 채널 1건으로 전원 갱신 — per-디바이스 예산 소진 없음.

const ENVS: ApnsEnvironment[] = ["production", "sandbox"];

export interface ChannelRow {
  game_id: string;
  environment: ApnsEnvironment;
  channel_id: string;
  status: "active" | "ending" | "deleted";
  last_score_state: string | null;
  last_state_hash: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  created_at: string;
  ending_at: string | null;
}

/** 지정 경기들의 active 채널 map — key `${gameId}|${env}`. (p2s payload·ACK 검증용) */
export async function getActiveChannels(
  gameIds: string[],
): Promise<Map<string, ChannelRow>> {
  const map = new Map<string, ChannelRow>();
  if (gameIds.length === 0) return map;
  const { data } = await supabase
    .from("live_activity_channels")
    .select("*")
    .in("game_id", gameIds)
    .eq("status", "active");
  for (const r of (data ?? []) as ChannelRow[]) map.set(`${r.game_id}|${r.environment}`, r);
  return map;
}

/**
 * start 윈도우(라이브 또는 30분 전 예정) 경기에 env별 채널을 생성한다(멱등 — 행 있으면 재사용).
 * 채널이 p2s payload·인앱 조회보다 먼저 존재해야 하므로 warmup에서 start 발송 전에 호출.
 */
export async function ensureLiveActivityChannels(
  games: KboRawGame[],
): Promise<{ created: number } | { error: string }> {
  if (!apnsConfigured()) return { created: 0 };
  const targets = games.filter(
    (g) => g.G_ID && liveActivityStartWindow(g) && g.CANCEL_SC_ID === "0",
  );
  if (targets.length === 0) return { created: 0 };

  const gameIds = targets.map((g) => g.G_ID as string);
  const { data: existing, error } = await supabase
    .from("live_activity_channels")
    .select("game_id, environment, status")
    .in("game_id", gameIds);
  if (error) return { error: error.message };
  const have = new Set(
    ((existing ?? []) as { game_id: string; environment: string; status: string }[])
      // deleted 행만 있는 (드문) 경우 재생성 허용 — active/ending이 있으면 재사용.
      .filter((r) => r.status !== "deleted")
      .map((r) => `${r.game_id}|${r.environment}`),
  );

  const jwt = await getProviderTokenSafe();
  if (!jwt) return { error: "apns provider token failed" };

  let created = 0;
  for (const gameId of gameIds) {
    for (const env of ENVS) {
      if (have.has(`${gameId}|${env}`)) continue;
      const channelId = await createBroadcastChannel(env, jwt);
      if (!channelId) continue; // 실패 → 다음 틱 재시도 (멱등)
      // upsert(ON CONFLICT 갱신): deleted 잔존 행이 있으면 새 채널로 재활성화.
      const { error: upErr } = await supabase.from("live_activity_channels").upsert(
        {
          game_id: gameId,
          environment: env,
          channel_id: channelId,
          status: "active",
          last_score_state: null,
          last_state_hash: null,
          attempt_count: 0,
          next_retry_at: null,
          created_at: new Date().toISOString(),
          ending_at: null,
          deleted_at: null,
        },
        { onConflict: "game_id,environment" },
      );
      if (upErr) {
        // 행 기록 실패 → 방금 만든 채널은 고아가 되므로 즉시 삭제 시도(한도 방어).
        await deleteBroadcastChannel(env, channelId, jwt);
        continue;
      }
      created += 1;
    }
  }
  return { created };
}

/**
 * 라이브 경기 채널 update broadcast + 종료/취소 end 시퀀스 + 스테일 sweep.
 * warmup 매분 호출. 반환 통계는 관제/로그용.
 */
export async function pushLiveActivityChannelBroadcasts(
  games: KboRawGame[],
  lastPlayByGame?: Map<string, string>,
): Promise<
  | { updates: number; skipped: number; ends: number; deleted: number }
  | { error: string }
> {
  if (!apnsConfigured()) return { updates: 0, skipped: 0, ends: 0, deleted: 0 };

  // 오늘 경기 + (경기 목록에 없어진) 잔존 채널까지 전부 관리 대상.
  const { data: rows, error } = await supabase
    .from("live_activity_channels")
    .select("*")
    .neq("status", "deleted");
  if (error) return { error: error.message };
  const channels = (rows ?? []) as ChannelRow[];
  if (channels.length === 0) return { updates: 0, skipped: 0, ends: 0, deleted: 0 };

  const jwt = await getProviderTokenSafe();
  if (!jwt) return { error: "apns provider token failed" };

  const gameById = new Map(games.filter((g) => g.G_ID).map((g) => [g.G_ID as string, g]));
  const now = Date.now();
  let updates = 0;
  let skipped = 0;
  let ends = 0;
  let deleted = 0;

  const markDeleted = async (row: ChannelRow) => {
    const ok = await deleteBroadcastChannel(row.environment, row.channel_id, jwt);
    if (!ok) return; // 삭제 실패 → 다음 틱 재시도
    await supabase
      .from("live_activity_channels")
      .update({ status: "deleted", deleted_at: new Date().toISOString() })
      .eq("game_id", row.game_id)
      .eq("environment", row.environment);
    deleted += 1;
  };

  for (const row of channels) {
    const g = gameById.get(row.game_id);
    const status = g ? liveActivityGameStatus(g) : "other";
    const isCancelled = g ? g.CANCEL_SC_ID !== "0" : false;

    // ── 스테일 sweep: 오늘 경기 목록에 없고 24h 지난 채널은 정리(한도 방어). ──
    if (!g && now - new Date(row.created_at).getTime() > 24 * 60 * 60 * 1000) {
      await markDeleted(row);
      continue;
    }

    // ── 종료/취소 → end broadcast + backoff 재시도 → 8h 후 DELETE ──
    if (row.status === "ending" || status === "final" || isCancelled) {
      const endingAtMs = row.ending_at ? new Date(row.ending_at).getTime() : now;
      if (row.status === "ending" && now - endingAtMs > CHANNEL_END_RETENTION_MS) {
        await markDeleted(row);
        continue;
      }
      const due =
        row.status !== "ending" || // 첫 end (즉시)
        (row.next_retry_at !== null && now >= new Date(row.next_retry_at).getTime());
      if (!due) continue;

      const cs = g
        ? buildLiveActivityContentState(
            g,
            isCancelled ? "scheduled" : "final",
            undefined,
            true,
          )
        : // 경기 목록에서 사라진 잔존 채널 — 최소 종료 프레임.
          { status: "final" };
      const res = await sendBroadcastPush({
        env: row.environment,
        channelId: row.channel_id,
        event: "end",
        contentState: cs as Record<string, unknown>,
        priority: "10",
        // 종료 15분 잔상(per-토큰 end와 동일 정책), 취소는 즉시 해제.
        dismissalDate: isCancelled
          ? Math.floor(now / 1000)
          : Math.floor(now / 1000) + 15 * 60,
        jwt,
      });
      if (res.ok) ends += 1;
      const nextAttempt = row.attempt_count + 1;
      const delayMin = endRetryDelayMinutes(nextAttempt);
      await supabase
        .from("live_activity_channels")
        .update({
          status: "ending",
          ending_at: row.ending_at ?? new Date(now).toISOString(),
          attempt_count: nextAttempt,
          next_retry_at: new Date(now + delayMin * 60 * 1000).toISOString(),
        })
        .eq("game_id", row.game_id)
        .eq("environment", row.environment);
      continue;
    }

    // ── 라이브 → update broadcast (priority 10/5, 무변화 스킵) ──
    if (status === "live" && g) {
      const cs = buildLiveActivityContentState(
        g,
        "live",
        lastPlayByGame?.get(row.game_id),
        true, // 채널 구독자는 빌드 16+ 확정 → 항상 풀 카드
      );
      const scoreState = scoreStateOf(cs);
      const fullHash = fullStateHashOf(cs);
      const decision = decideChannelPush({
        scoreState,
        fullStateHash: fullHash,
        lastScoreState: row.last_score_state,
        lastStateHash: row.last_state_hash,
      });
      if (!decision.send) {
        skipped += 1;
        continue;
      }
      const res = await sendBroadcastPush({
        env: row.environment,
        channelId: row.channel_id,
        event: "update",
        contentState: cs,
        priority: decision.priority,
        jwt,
      });
      if (res.ok) {
        updates += 1;
        await supabase
          .from("live_activity_channels")
          .update({ last_score_state: scoreState, last_state_hash: fullHash })
          .eq("game_id", row.game_id)
          .eq("environment", row.environment);
      }
    }
    // scheduled: 카드가 아직 scheduled 프레임(p2s가 실음) — 첫 live 틱부터 broadcast.
  }

  return { updates, skipped, ends, deleted };
}
