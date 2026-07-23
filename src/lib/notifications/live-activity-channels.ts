import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isKboGameCancelled } from "@/lib/crawler/kbo-status";
import { apnsConfigured, getProviderTokenSafe } from "@/lib/notifications/apns";
import {
  createBroadcastChannel,
  deleteBroadcastChannel,
  sendBroadcastPush,
  type ApnsEnvironment,
} from "@/lib/notifications/apns-broadcast";
import {
  resolveChannelUpdateDecision,
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
  /** 마지막 성공 p10 broadcast 시각 — ≤2분 heartbeat 판정 재료(삼순 ②, 성공 시에만 전진). */
  last_p10_at: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  created_at: string;
  ending_at: string | null;
}

/** 레거시 판정용 직전 상태 스냅샷 항목 (snapshotChannelLastStates). */
export interface ChannelLastState {
  score: string | null;
  hash: string | null;
}

/**
 * broadcast 직전의 production 채널 상태 스냅샷 (삼순 R2 blocker① — 레거시 분리용).
 * 레거시 per-토큰 판정은 "직전 틱" hash를 읽어야 하는데, broadcast가 먼저 돌면 hash가
 * 이미 전진돼 레거시가 영구 skip된다(구빌드 카드 프리즈). 이 스냅샷을 broadcast *전*에
 * 떠서 레거시에 주입(pushLiveActivityUpdates channelLastStateOverride)하면, 레거시를
 * broadcast 뒤/병렬로 뽑아도(느린 fanout 분리) 직전-틱 판정이 그대로 유지된다.
 */
export async function snapshotChannelLastStates(
  gameIds: string[],
): Promise<Map<string, ChannelLastState>> {
  const map = new Map<string, ChannelLastState>();
  if (gameIds.length === 0 || !apnsConfigured()) return map;
  // query-guard: bounded -- 하루 라이브 경기 gameIds(≤10이니)×production env로 PK 부분키 유계
  const { data, error } = await supabase
    .from("live_activity_channels")
    .select("game_id, last_score_state, last_state_hash")
    .in("game_id", gameIds)
    .eq("environment", "production")
    .eq("status", "active");
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as {
    game_id: string; last_score_state: string | null; last_state_hash: string | null;
  }[]) {
    map.set(r.game_id, { score: r.last_score_state, hash: r.last_state_hash });
  }
  return map;
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
    (g) => g.G_ID && liveActivityStartWindow(g) && !isKboGameCancelled(g.CANCEL_SC_ID),
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
        last_p10_at: null,
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
  opts?: {
    /**
     * 유실 catch-up(삼순 R1 blocker②) — 이 경기들은 무변화 skip 판정이어도 p10
     * current-state를 1회 강제 재발송(broadcast는 최신 상태 멱등 — 중복 무해).
     * 호출측(live-fast-path catch-up 틱)이 빈도를 유계한다.
     */
    forceCurrentStateGameIds?: ReadonlySet<string>;
  },
): Promise<
  | {
      updates: number;
      heartbeats: number;
      catchups: number;
      skipped: number;
      ends: number;
      deleted: number;
      /**
       * update broadcast APNs transient 실패(5xx/timeout 등, ChannelNotRegistered 제외)
       * 경기 ID — 호출측(live-fast-path)이 이 경기만 catch-up pending으로 재-arm해
       * updates=0이어도 stale이 2분 heartbeat까지 남지 않게 한다(삼순 R3 blocker②).
       */
      failedGameIds: string[];
    }
  | { error: string }
> {
  const zero = {
    updates: 0, heartbeats: 0, catchups: 0, skipped: 0, ends: 0, deleted: 0, failedGameIds: [],
  };
  if (!apnsConfigured()) return zero;

  // 오늘 경기 + (경기 목록에 없어진) 잔존 채널까지 전부 관리 대상.
  const { data: rows, error } = await supabase
    .from("live_activity_channels")
    .select("*")
    .neq("status", "deleted");
  if (error) return { error: error.message };
  const channels = (rows ?? []) as ChannelRow[];
  if (channels.length === 0) return zero;

  const jwt = await getProviderTokenSafe();
  if (!jwt) return { error: "apns provider token failed" };

  const gameById = new Map(games.filter((g) => g.G_ID).map((g) => [g.G_ID as string, g]));
  const now = Date.now();
  let updates = 0;
  let heartbeats = 0;
  let catchups = 0;
  let skipped = 0;
  let ends = 0;
  let deleted = 0;
  // update broadcast가 transient하게 실패한 라이브 경기(삼순 R3 blocker②) — 호출측 재-arm용.
  const failedGameIds = new Set<string>();

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
    const isCancelled = g ? isKboGameCancelled(g.CANCEL_SC_ID) : false;

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
      // 판정 합성(base diff → 2분 heartbeat → 지명 catch-up)은 순수 함수로 — 매트릭스는
      // qa:la-broadcast가 고정. 지명 catch-up(삼순 R2 blocker③)은 base가 skip이든 p5든
      // 항상 p10으로 승격(relay lastPlay만 달라진 p5 틱이 catch-up을 삼켜 놓친 단말이
      // 2분 heartbeat까지 stale로 남던 구멍 폐쇄). 자연 p10이면 그 발송이 겸한다.
      const lastP10AtMs = row.last_p10_at ? new Date(row.last_p10_at).getTime() : null;
      const { decision, isHeartbeat, isForcedCatchup: forcedCatchup } =
        resolveChannelUpdateDecision({
          scoreState,
          fullStateHash: fullHash,
          lastScoreState: row.last_score_state,
          lastStateHash: row.last_state_hash,
          lastP10AtMs,
          nowMs: now,
          forceCatchup: opts?.forceCurrentStateGameIds?.has(row.game_id) === true,
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
        if (isHeartbeat) heartbeats += 1;
        if (forcedCatchup) catchups += 1;
        const patch: Record<string, unknown> = {
          last_score_state: scoreState,
          last_state_hash: fullHash,
        };
        // last_p10_at은 *성공한 p10*만 전진(transient 실패/p5는 미전진 — 삼순 ②).
        if (decision.priority === "10") patch.last_p10_at = new Date(now).toISOString();
        await supabase
          .from("live_activity_channels")
          .update(patch)
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
      } else {
        // 그 외 실패 = APNs 5xx/timeout 등 transient(삼순 R3 blocker②) — 이 경기를
        // 호출측이 catch-up pending으로 재-arm하도록 보고. last_state_hash를 전진시키지
        // 않았으므로 다음 틱 자연 재시도도 가능하고, catch-up p10이 즉시 수습한다.
        failedGameIds.add(row.game_id);
      }
    }
    // scheduled: 카드가 아직 scheduled 프레임(p2s가 실음) — 첫 live 틱부터 broadcast.
  }

  return { updates, heartbeats, catchups, skipped, ends, deleted, failedGameIds: [...failedGameIds] };
}
