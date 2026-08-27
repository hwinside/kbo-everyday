import { isKboGameCancelled } from "@/lib/crawler/kbo-status";
import {
  resolveChannelUpdateDecision,
  scoreStateOf,
  fullStateHashOf,
  isBallStrikeOnlyChange,
  endRetryDelayMinutes,
  CHANNEL_END_RETENTION_MS,
} from "@/lib/notifications/live-activity-channel-policy";
import type { KboRawGame } from "@/types/api";
// type-only import — 런타임 로드 없음(스모크가 supabase/APNs env 없이 이 모듈을 import 가능).
import type { ApnsEnvironment } from "@/lib/notifications/apns-broadcast";
import type { ChannelRow } from "@/lib/notifications/live-activity-channels";

// 채널 broadcast 발송 pass — pushLiveActivityChannelBroadcasts의 채널 순회/판정/발송
// 루프를 io 주입형으로 분리한 것(삼순 R4 blocker② 회귀 대상). supabase/APNs 실구현은
// live-activity-channels.ts가 주입하고, qa:la-broadcast는 fake clock/실패 send를 주입해
// *동일 루프*에서 deadline 유계 종료·재-arm을 검증한다.
//
// ── 요청-절대 deadline (삼순 R4 blocker②) ──
// sendBroadcastPush는 채널별 APNs http2 8s timeout을 *직렬* await하므로, 5경기×2 env
// 전부 timeout이면 80s — maxDuration(75s) 504가 구조적으로 가능했다. 이 pass는 매 행
// 처리 전에 deadlineAtMs를 검사해 초과 시 발송을 *시작하지 않고* 명시 종료한다:
//  - 라이브 행 → failedGameIds에 넣어 호출측(live-fast-path)이 catch-up pending으로
//    재-arm(다음 무변화 틱 p10 1회로 수습 — 유계).
//  - end/스테일 행 → skip(다음 분 cron이 backoff/sweep 그대로 재시도 — 멱등).
// 마지막으로 시작된 send 1건만 최대 8s를 넘길 수 있어, 상한은 deadline + 8s로 유계.

export interface ChannelBroadcastStats {
  updates: number;
  heartbeats: number;
  catchups: number;
  skipped: number;
  /** skip 사유별 분해(삼순 2026-08-27 게이트 ⓐ) — skipped = 세 값의 합. */
  retreatSkipped: number;
  coalescedSkipped: number;
  noChangeSkipped: number;
  /** retreat 중 heartbeat 복구 발송(마지막 성공 콘텐츠 재전송) 수 — heartbeats 에도 포함. */
  retreatHeartbeats: number;
  ends: number;
  deleted: number;
  /**
   * update broadcast APNs transient 실패(5xx/timeout 등, ChannelNotRegistered 제외) +
   * deadline 초과로 발송을 시작하지 못한 라이브 경기 ID — 호출측(live-fast-path)이 이
   * 경기만 catch-up pending으로 재-arm해 stale이 2분 heartbeat까지 남지 않게 한다
   * (삼순 R3 blocker② + R4 blocker②).
   */
  failedGameIds: string[];
  /** deadline 초과로 처리(발송/삭제)를 시작하지 않은 행 수 — 관제용. */
  deadlineSkipped: number;
}

export interface ChannelBroadcastPassDeps {
  now(): number;
  gameStatus(g: KboRawGame): "live" | "final" | "scheduled" | "other";
  buildContentState(
    g: KboRawGame,
    status: "live" | "final" | "scheduled",
    lastPlay: string | undefined,
    full: boolean,
  ): Record<string, unknown>;
  send(params: {
    env: ApnsEnvironment;
    channelId: string;
    event: "update" | "end";
    contentState: Record<string, unknown>;
    priority: "10" | "5";
    dismissalDate?: number;
  }): Promise<{ ok: boolean; reason?: string }>;
  deleteChannel(env: ApnsEnvironment, channelId: string): Promise<boolean>;
  /**
   * generation fence(channelMutationFence) 적용 행 update — 실구현이 fence를 건다.
   * requireActive면 status='active' 조건 추가(ChannelNotRegistered 무효화 경로).
   * affected 행 수 반환(0 = stale worker no-op).
   */
  updateChannel(
    row: ChannelRow,
    patch: Record<string, unknown>,
    opts?: { requireActive?: boolean },
  ): Promise<number>;
}

export async function runChannelBroadcastPass(
  channels: ChannelRow[],
  games: KboRawGame[],
  lastPlayByGame: Map<string, string> | undefined,
  opts: {
    /** 유실 catch-up — 무변화 skip 판정이어도 p10 current-state 강제(호출측이 빈도 유계). */
    forceCurrentStateGameIds?: ReadonlySet<string>;
    /** 요청-절대 deadline(epoch ms) — 초과 시 새 발송/삭제를 시작하지 않고 명시 종료. */
    deadlineAtMs?: number;
  },
  deps: ChannelBroadcastPassDeps,
): Promise<ChannelBroadcastStats> {
  const gameById = new Map(games.filter((g) => g.G_ID).map((g) => [g.G_ID as string, g]));
  let updates = 0;
  let heartbeats = 0;
  let catchups = 0;
  let skipped = 0;
  let retreatSkipped = 0;
  let coalescedSkipped = 0;
  let noChangeSkipped = 0;
  let retreatHeartbeats = 0;
  let ends = 0;
  let deleted = 0;
  let deadlineSkipped = 0;
  const failedGameIds = new Set<string>();

  const pastDeadline = () => opts.deadlineAtMs != null && deps.now() >= opts.deadlineAtMs;

  const markDeleted = async (row: ChannelRow) => {
    const ok = await deps.deleteChannel(row.environment, row.channel_id);
    if (!ok) return; // 삭제 실패 → 다음 틱 재시도
    // generation fence: 그 사이 같은 PK가 새 채널로 재생성됐으면 affected 0 = no-op.
    const affected = await deps.updateChannel(row, {
      status: "deleted",
      deleted_at: new Date(deps.now()).toISOString(),
    });
    if (affected > 0) deleted += 1;
  };

  for (const row of channels) {
    const g = gameById.get(row.game_id);
    const status = g ? deps.gameStatus(g) : "other";
    const isCancelled = g ? isKboGameCancelled(g.CANCEL_SC_ID) : false;
    const now = deps.now();

    // ── 요청-절대 deadline (삼순 R4 blocker②) — 이 행의 발송/삭제를 시작하지 않는다. ──
    if (pastDeadline()) {
      deadlineSkipped += 1;
      // 라이브 경기는 재-arm 대상으로 보고 — last_state_hash도 전진 안 했으니 다음 분
      // 자연 재시도 + catch-up p10이 수습. end/스테일은 다음 분 backoff/sweep 그대로.
      if (status === "live" && g) failedGameIds.add(row.game_id);
      continue;
    }

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
        ? deps.buildContentState(g, isCancelled ? "scheduled" : "final", undefined, true)
        : // 경기 목록에서 사라진 잔존 채널 — 최소 종료 프레임.
          { status: "final" };
      const res = await deps.send({
        env: row.environment,
        channelId: row.channel_id,
        event: "end",
        contentState: cs,
        priority: "10",
        // 종료 15분 잔상(per-토큰 end와 동일 정책), 취소는 즉시 해제.
        dismissalDate: isCancelled
          ? Math.floor(now / 1000)
          : Math.floor(now / 1000) + 15 * 60,
      });
      if (res.ok) ends += 1;
      else if (res.reason === "ChannelNotRegistered") {
        // 채널이 이미 Apple 쪽에 없음 — 재시도 무의미, 행만 정리(deleteChannel도
        // 이 reason을 멱등 성공 처리하므로 markDeleted가 안전하게 통과).
        await markDeleted(row);
        continue;
      }
      const nextAttempt = row.attempt_count + 1;
      const delayMin = endRetryDelayMinutes(nextAttempt);
      await deps.updateChannel(row, {
        status: "ending",
        ending_at: row.ending_at ?? new Date(now).toISOString(),
        attempt_count: nextAttempt,
        next_retry_at: new Date(now + delayMin * 60 * 1000).toISOString(),
      });
      continue;
    }

    // ── 라이브 → update broadcast (priority 10/5, 무변화 스킵) ──
    if (status === "live" && g) {
      const cs = deps.buildContentState(
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
      const lastSendAtMs = row.last_send_at ? new Date(row.last_send_at).getTime() : null;
      const hasLastContent =
        row.last_content_state != null && typeof row.last_content_state === "object";
      // p5 코얼레싱 자격(삼순 재리뷰 P1·재리뷰2 Blocker③): *볼/스트라이크만* 바뀐 틱만.
      // 기준 = 매 성공 발송마다 전진하는 last_state_hash(직전 발송 전체축) — last_content_state
      // (복구 재료, 득점 시에만 갱신)와 용도 분리. content 기준이면 득점 후 타자가 바뀌는
      // 순간부터 다음 득점까지 코얼레싱이 영구 비활성이 된다(diet 무력화).
      const p5CoalesceEligible = isBallStrikeOnlyChange(row.last_state_hash, fullHash);
      const { decision, isHeartbeat, isForcedCatchup: forcedCatchup, skipReason, resendLastContent } =
        resolveChannelUpdateDecision({
          scoreState,
          fullStateHash: fullHash,
          lastScoreState: row.last_score_state,
          lastStateHash: row.last_state_hash,
          lastP10AtMs,
          nowMs: now,
          forceCatchup: opts.forceCurrentStateGameIds?.has(row.game_id) === true,
          lastSendAtMs,
          hasLastContent,
          p5CoalesceEligible,
        });
      if (!decision.send) {
        skipped += 1;
        if (skipReason === "retreat") retreatSkipped += 1;
        else if (skipReason === "p5_coalesced") coalescedSkipped += 1;
        else noChangeSkipped += 1;
        continue;
      }
      // retreat 중 heartbeat 복구(삼순 2026-08-27 조건①): 현재 스냅샷(후퇴값)이 아니라
      // 마지막 성공 발송 콘텐츠를 그대로 재전송 — 유실 단말만 복구하고 되감김은 불가능.
      const sendContent = resendLastContent
        ? (row.last_content_state as Record<string, unknown>)
        : cs;
      const res = await deps.send({
        env: row.environment,
        channelId: row.channel_id,
        event: "update",
        contentState: sendContent,
        priority: decision.priority,
      });
      if (res.ok) {
        updates += 1;
        if (isHeartbeat) heartbeats += 1;
        if (resendLastContent) retreatHeartbeats += 1;
        if (forcedCatchup) catchups += 1;
        const patch: Record<string, unknown> = resendLastContent
          ? {} // 재전송은 상태 무이동 — hash/score/content 모두 마지막 성공값 그대로.
          : {
              last_score_state: scoreState,
              last_state_hash: fullHash,
            };
        // 마지막 성공 발송 콘텐츠 보존(삼순 ① 재료) — 삼순 재리뷰 Blocker② 반영: score축이
        // *전진(변화)했을 때만* 갱신. stale-equal p5 틱(점수 동일·relay 폴백)의 낡은 스냅샷이
        // 복구 재료를 오염시켜 "옛 값 2분 재방송"이 되는 경로 차단. retreat 는 위에서 이미
        // skip/재전송이라 여기 도달하는 score 변화 = 전진뿐이다.
        if (!resendLastContent && scoreState !== row.last_score_state) {
          patch.last_content_state = cs;
        }
        patch.last_send_at = new Date(now).toISOString();
        // last_p10_at은 *성공한 p10*만 전진(transient 실패/p5는 미전진 — 삼순 ②).
        if (decision.priority === "10") patch.last_p10_at = new Date(now).toISOString();
        await deps.updateChannel(row, patch); // generation fence — 새 채널에 옛 hash 기록 방지
      } else if (res.reason === "ChannelNotRegistered") {
        // Apple 쪽에 채널이 없음(외부 삭제 등) — active 행을 무효화해 다음 틱
        // ensureLiveActivityChannels의 deleted-CAS 경로가 새 채널로 재생성하게 한다.
        // generation fence 포함 — 그 사이 재생성된 새 채널 행은 건드리지 않는다.
        await deps.updateChannel(
          row,
          { status: "deleted", deleted_at: new Date(deps.now()).toISOString() },
          { requireActive: true },
        );
      } else {
        // 그 외 실패 = APNs 5xx/timeout 등 transient(삼순 R3 blocker②) — 이 경기를
        // 호출측이 catch-up pending으로 재-arm하도록 보고. last_state_hash를 전진시키지
        // 않았으므로 다음 틱 자연 재시도도 가능하고, catch-up p10이 즉시 수습한다.
        failedGameIds.add(row.game_id);
      }
    }
    // scheduled: 카드가 아직 scheduled 프레임(p2s가 실음) — 첫 live 틱부터 broadcast.
  }

  return {
    updates, heartbeats, catchups, skipped,
    retreatSkipped, coalescedSkipped, noChangeSkipped, retreatHeartbeats,
    ends, deleted,
    failedGameIds: [...failedGameIds],
    deadlineSkipped,
  };
}
