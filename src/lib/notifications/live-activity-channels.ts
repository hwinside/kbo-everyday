import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isKboGameCancelled } from "@/lib/crawler/kbo-status";
import { apnsConfigured, getProviderTokenSafe } from "@/lib/notifications/apns";
import {
  createBroadcastChannel,
  deleteBroadcastChannel,
  sendBroadcastPush,
  type ApnsEnvironment,
} from "@/lib/notifications/apns-broadcast";
import { channelMutationFence } from "@/lib/notifications/live-activity-channel-policy";
import {
  runChannelBroadcastPass,
  type ChannelBroadcastStats,
} from "@/lib/notifications/live-activity-channel-broadcast-pass";
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
  /** 마지막 성공 발송 시각(p10/p5 불문) — p5 코얼레싱 기준(삼순 2026-08-27 조건②). */
  last_send_at: string | null;
  /** 마지막 성공 발송 콘텐츠 — retreat 중 heartbeat 재전송 재료(삼순 2026-08-27 조건①). */
  last_content_state: Record<string, unknown> | null;
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
  opts?: {
    /**
     * 요청-절대 deadline(epoch ms) — 초과 시 남은 채널 생성을 *시작하지 않고* 명시
     * 종료(삼순 R4 blocker②: createBroadcastChannel도 http2 8s timeout 직렬이라 첫
     * 분 5경기×2 env 전부 실패 시 80s 가능). 미생성분은 다음 분 cron이 멱등 재시도.
     */
    deadlineAtMs?: number;
  },
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
      if (opts?.deadlineAtMs != null && Date.now() >= opts.deadlineAtMs) return { created };
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
    /**
     * 요청-절대 deadline(epoch ms) — 삼순 R4 blocker②. 초과 시 새 발송을 시작하지 않고
     * 명시 종료하며, 미발송 라이브 경기는 failedGameIds로 보고돼 호출측이 다음 틱에
     * 재-arm한다(상세는 live-activity-channel-broadcast-pass.ts 상단 주석).
     */
    deadlineAtMs?: number;
  },
): Promise<ChannelBroadcastStats | { error: string }> {
  const zero: ChannelBroadcastStats = {
    updates: 0, heartbeats: 0, catchups: 0, skipped: 0,
    retreatSkipped: 0, coalescedSkipped: 0, noChangeSkipped: 0, retreatHeartbeats: 0,
    ends: 0, deleted: 0,
    failedGameIds: [], deadlineSkipped: 0,
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

  // 채널 순회/판정/발송 루프는 io 주입형 pass로 분리(삼순 R4 blocker② 회귀 대상) —
  // qa:la-broadcast가 fake clock/실패 send로 *동일 루프*의 deadline 유계 종료·재-arm을
  // 검증한다. 실구현 io: APNs send/DELETE + generation fence 적용 supabase update.
  const stats = await runChannelBroadcastPass(
    channels,
    games,
    lastPlayByGame,
    {
      forceCurrentStateGameIds: opts?.forceCurrentStateGameIds,
      deadlineAtMs: opts?.deadlineAtMs,
    },
    {
      now: () => Date.now(),
      gameStatus: liveActivityGameStatus,
      buildContentState: (g, status, lastPlay, full) =>
        buildLiveActivityContentState(g, status, lastPlay, full),
      send: (p) => sendBroadcastPush({ ...p, jwt }),
      deleteChannel: (env, channelId) => deleteBroadcastChannel(env, channelId, jwt),
      updateChannel: async (row, patch, o) => {
        let q = supabase
          .from("live_activity_channels")
          .update(patch)
          .match(channelMutationFence(row)); // generation fence — 재생성 행 보호
        if (o?.requireActive) q = q.eq("status", "active");
        const { data } = await q.select("game_id");
        return data?.length ?? 0;
      },
    },
  );
  // skip 사유 관측(삼순 2026-08-27 게이트 ⓐ) — retreat/코얼레싱은 카드 정지 진단의 1차
  // 재료라 발생 시 반드시 로그를 남긴다(과거 "발송 안 된 틱"이 무기록이던 생존자 편향 폐쇄).
  if (stats.retreatSkipped > 0 || stats.coalescedSkipped > 0 || stats.retreatHeartbeats > 0) {
    console.log(
      `[la-broadcast] skips retreat=${stats.retreatSkipped} coalesced=${stats.coalescedSkipped}` +
      ` noChange=${stats.noChangeSkipped} retreatHeartbeats=${stats.retreatHeartbeats}` +
      ` updates=${stats.updates}`,
    );
  }
  return stats;
}
