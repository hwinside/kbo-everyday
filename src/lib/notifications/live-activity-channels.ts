import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { apnsConfigured, getProviderTokenSafe } from "@/lib/notifications/apns";
import {
  createBroadcastChannel,
  deleteBroadcastChannel,
  sendBroadcastPush,
  type ApnsEnvironment,
} from "@/lib/notifications/apns-broadcast";
import {
  decideChannelBroadcastTick,
  scoreStateOf,
  fullStateHashOf,
  endRetryDelayMinutes,
  channelMutationFence,
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
  /** 마지막 broadcast 발송(accepted) 시각 — 무변화 heartbeat 판정용 (삼순 blocker①). */
  last_broadcast_at: string | null;
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

  // dedupe — 같은 gameId 중복 행이 와도 (game, env)당 1회만 시도 (삼순 #659 blocker①).
  const gameIds = [...new Set(targets.map((g) => g.G_ID as string))];
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
      const row = {
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
      };
      // ── 동시 cron 대비 winner-take-all (삼순 #659 blocker①) ──
      // upsert(ON CONFLICT 갱신)는 마지막 쓰기가 이겨 loser 채널이 고아로 남고, 그 사이
      // loser ID를 조회·구독한 클라가 영구 프리즈된다. 대신:
      //  1) ON CONFLICT DO NOTHING insert — 신규 행이면 내가 winner.
      //  2) 충돌이면 status='deleted' 행에 한해 CAS 재활성(WHERE status='deleted' — 행 락으로
      //     직렬화돼 정확히 한 cron만 성공).
      //  3) 둘 다 실패 = 다른 cron이 이미 active/ending 행 보유 → 내가 loser: 방금 만든
      //     채널을 즉시 DELETE(고아·한도 방어). DB에 남는 ID는 항상 정확히 1개.
      const { data: won, error: insErr } = await supabase
        .from("live_activity_channels")
        .upsert(row, { onConflict: "game_id,environment", ignoreDuplicates: true })
        .select("game_id");
      if (!insErr && won && won.length > 0) {
        created += 1;
        continue;
      }
      if (!insErr) {
        const { data: cas } = await supabase
          .from("live_activity_channels")
          .update(row)
          .eq("game_id", gameId)
          .eq("environment", env)
          .eq("status", "deleted")
          .select("game_id");
        if (cas && cas.length > 0) {
          created += 1;
          continue;
        }
      }
      // loser 또는 insert/CAS 응답 오류 — 내 채널을 지우기 전에 canonical 행을 재조회한다
      // (삼순 재리뷰 blocker①): DB 커밋은 됐는데 응답만 유실된 경우 내 channel_id가
      // canonical일 수 있고, 그때 지우면 winner 채널을 파괴한다. 내 것이 아닐 때만 DELETE.
      const { data: canonical } = await supabase
        .from("live_activity_channels")
        .select("channel_id")
        .eq("game_id", gameId)
        .eq("environment", env)
        .maybeSingle();
      if (canonical?.channel_id === channelId) {
        created += 1; // 내 커밋이 살아있음 — 응답 유실이었을 뿐.
      } else {
        await deleteBroadcastChannel(env, channelId, jwt);
      }
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
    // generation fence(삼순 재리뷰 blocker①): 그 사이 같은 PK가 새 채널로 재생성됐으면
    // affected 0 = stale worker 결과 → no-op (새 채널 행을 deleted 처리하지 않음).
    const { data: affected } = await supabase
      .from("live_activity_channels")
      .update({ status: "deleted", deleted_at: new Date().toISOString() })
      .match(channelMutationFence(row))
      .select("game_id");
    if (affected && affected.length > 0) deleted += 1;
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
      else if (res.reason === "ChannelNotRegistered") {
        // 채널이 이미 Apple 쪽에 없음 — 재시도 무의미, 행만 정리(deleteBroadcastChannel도
        // 이 reason을 멱등 성공 처리하므로 markDeleted가 안전하게 통과).
        await markDeleted(row);
        continue;
      }
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
        .match(channelMutationFence(row)); // generation fence — 재생성 행 보호
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
      // heartbeat 포함 판정 — No-Message-Stored 미수신 단말 고착 바운드(삼순 blocker①).
      const decision = decideChannelBroadcastTick({
        scoreState,
        fullStateHash: fullHash,
        lastScoreState: row.last_score_state,
        lastStateHash: row.last_state_hash,
        lastBroadcastAtMs: row.last_broadcast_at
          ? new Date(row.last_broadcast_at).getTime()
          : null,
        nowMs: now,
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
          .update({
            last_score_state: scoreState,
            last_state_hash: fullHash,
            // heartbeat 간격 기준점 — 발송 성공(accepted) 틱마다 갱신.
            last_broadcast_at: new Date(now).toISOString(),
          })
          .match(channelMutationFence(row)); // generation fence — 새 채널에 옛 hash 기록 방지
      } else if (res.reason === "ChannelNotRegistered") {
        // Apple 쪽에 채널이 없음(외부 삭제 등) — active 행을 무효화해 다음 틱
        // ensureLiveActivityChannels의 deleted-CAS 경로가 새 채널로 재생성하게 한다(삼순 blocker②).
        // generation fence 포함 — 그 사이 재생성된 새 채널 행은 건드리지 않는다.
        await supabase
          .from("live_activity_channels")
          .update({ status: "deleted", deleted_at: new Date().toISOString() })
          .match(channelMutationFence(row))
          .eq("status", "active");
      }
    }
    // scheduled: 카드가 아직 scheduled 프레임(p2s가 실음) — 첫 live 틱부터 broadcast.
  }

  return { updates, skipped, ends, deleted };
}
