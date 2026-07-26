import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers, WIDGET_STREAM } from "@/lib/notifications/fcm";
import { TEAMS } from "@/lib/constants/teams";
import { fetchStandings, isKboGameCancelled } from "@/lib/crawler/kbo-api";
import { decideEndStreakCount, type StreakDir } from "@/lib/notifications/end-streak-policy";
import {
  shouldSendStartNotification,
  type StartPlateAppearanceEvidence,
} from "@/lib/notifications/start-freshness-policy";
import { fetchTeamFanIds } from "@/lib/notifications/audience";
import type { KboRawGame } from "@/types/api";
import {
  deliverGameStartBatch,
  deliverGameStartSnapshot,
  finalizeGameStartSnapshot,
  openGameStartSnapshot,
  START_DELIVERY_ATTEMPT_MS,
  type GameStartDeliveryBatchResult,
  type GameStartDeliveryResult,
  type GameStartDeliveryTarget,
} from "@/lib/notifications/game-start-delivery";

const START_DELIVERY_BATCH_CONCURRENCY_PER_GAME = 2;

// 경기 시작/종료 알림 (push-notifications-v1 S4).
// warmup cron(경기 시간대 매분)이 호출. 중복 발화 방지 = game_notify_state
// 조건부 UPDATE 선점 — 다중 인스턴스가 동시에 돌아도 발송은 1회.

// 시작 알림 정시-only 게이트 (2026-07-23 삼순 post-merge blocker 반영):
// 기존 예정시각 +90분 catch-up 윈도우는 장애 복구 시 최대 90분 뒷북을 허용해 제거.
// 대신 warmup cron이 "예정(state 1)" 관측 시각을 last_seen_scheduled_at에 기록하고,
// scheduled→live 전환을 최근 연속 관측한 경우에만 발송한다(shouldSendStartNotification).

export function teamIdByShortName(name: string): number | null {
  const t = TEAMS.find((t) => t.shortName === name);
  return t?.id ?? null;
}

/** G_DT("20260611") + G_TM("18:30", KST) → epoch ms. 파싱 실패 시 null */
function scheduledStartMs(gDt: string | undefined, gTm: string | undefined): number | null {
  if (!gDt || !gTm || gDt.length !== 8 || !/^\d{2}:\d{2}$/.test(gTm)) return null;
  const y = +gDt.slice(0, 4), mo = +gDt.slice(4, 6), d = +gDt.slice(6, 8);
  const [hh, mm] = gTm.split(":").map(Number);
  // KST(UTC+9) wall-clock → UTC epoch
  return Date.UTC(y, mo - 1, d, hh - 9, mm);
}

/** 현재 KST 날짜 "YYYYMMDD" (G_DT와 같은 포맷, 사전식 비교용). */
function kstDateStr(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

/** 현재 KST 날짜 "YYYY-MM-DD" (daily_standings_snapshot.date 포맷). */
function kstDateIso(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 양팀을 최애팀으로 둔 유저 id 목록. ok=false면 조회 실패(재시도 대상) */
export async function fansOfTeams(
  teamIds: number[],
  opts?: { deadlineAtMs?: number },
): Promise<{ ids: string[]; ok: boolean }> {
  if (teamIds.length === 0) return { ids: [], ok: true };
  try {
    return { ids: await fetchTeamFanIds(teamIds, opts), ok: true };
  } catch (error) {
    console.error("[game-status] fans query failed:", (error as Error).message);
    return { ids: [], ok: false };
  }
}

// 종료 알림은 수신자 최애팀 기준으로 승팀/패팀 다른 메시지라 한 게임에서 away/home
// 두 그룹으로 나눠 발송한다. 상태를 game 단위 end_notified 하나로 두면 한 그룹 성공·다른
// 그룹 실패 시 전체 롤백 → 성공 그룹 중복 발송 위험이 있어, 팀 슬롯 단위로 선점한다 (삼순 #210).
type NotifyFlag =
  | "start_notified"
  | "end_notified"
  | "end_away_notified"
  | "end_home_notified"
  | "cancel_notified";

/**
 * 알림 권한 선점 — 해당 플래그가 false인 행을 true로 바꾸는 데 성공한
 * 호출만 발송 자격을 가짐 (semantic key = game_id + 플래그).
 */
async function claim(gameId: string, flag: NotifyFlag): Promise<boolean> {
  // 행 보장 (이미 있으면 no-op)
  const { error: insertErr } = await supabase
    .from("game_notify_state")
    .upsert({ game_id: gameId }, { onConflict: "game_id", ignoreDuplicates: true });
  if (insertErr) {
    console.error("[game-status] state upsert failed:", insertErr.message);
    return false;
  }
  const { data, error } = await supabase
    .from("game_notify_state")
    .update({ [flag]: true, updated_at: new Date().toISOString() })
    .eq("game_id", gameId)
    .eq(flag, false)
    .select("game_id");
  if (error) {
    console.error("[game-status] claim failed:", error.message);
    return false;
  }
  return (data ?? []).length > 0; // 0행 = 이미 다른 호출이 발송함
}

/** 발송 인프라 실패 시 선점 플래그를 되돌려 다음 cron이 재시도하게 함 (삼순 #210-1) */
async function unclaim(gameId: string, flag: NotifyFlag): Promise<void> {
  const { error } = await supabase
    .from("game_notify_state")
    .update({ [flag]: false, updated_at: new Date().toISOString() })
    .eq("game_id", gameId);
  if (error) console.error("[game-status] unclaim failed:", error.message);
}

/**
 * teamId → 연승/연패 { n, dir }. 2 미만이거나 미상이면 미수록.
 * KBO standings의 continuousGameResult("3승"/"1패") 기반 — 종료 직후 갱신 지연이
 * 있으면 직전 streak일 수 있어, 표기는 호출부에서 "이번 경기 결과 방향과 일치할 때만"
 * 노출(fail-closed)한다. fetch 실패 시 빈 맵(스코어만 발송).
 */
async function fetchTeamStreaks(): Promise<Map<number, { n: number; dir: "승" | "패" }>> {
  const out = new Map<number, { n: number; dir: "승" | "패" }>();
  try {
    const standings = await fetchStandings();
    for (const s of standings) {
      const m = (s.continuousGameResult ?? "").match(/^(\d+)(승|패)$/);
      if (!m) continue;
      const n = parseInt(m[1]);
      if (n >= 2 && s.teamId > 0) out.set(s.teamId, { n, dir: m[2] as "승" | "패" });
    }
  } catch (e) {
    console.error("[game-status] standings fetch failed:", (e as Error).message);
  }
  return out;
}

/**
 * 오늘(KST) 날짜 daily_standings_snapshot의 streak 맵 (01:00 cron이 적재한 "어제까지" 누적).
 * 조회 실패 또는 행 0(cron 미실행) → null = 호출부가 라이브 방향일치 로직으로 폴백.
 */
async function fetchSnapshotStreaks(): Promise<Map<number, string | null> | null> {
  const { data, error } = await supabase
    .from("daily_standings_snapshot")
    .select("team_id, streak")
    .eq("date", kstDateIso());
  if (error) {
    console.error("[game-status] snapshot streak fetch failed:", error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  return new Map(data.map((r: { team_id: number; streak: string | null }) => [r.team_id, r.streak]));
}

/** 도입 직후/과거 경기 보호 — 발송 없이 플래그만 마킹 */
async function markOnly(gameId: string, flags: { start?: boolean; end?: boolean; cancel?: boolean }): Promise<void> {
  await supabase.from("game_notify_state").upsert({
    game_id: gameId,
    ...(flags.start ? { start_notified: true } : {}),
    ...(flags.end ? { end_notified: true } : {}),
    ...(flags.cancel ? { cancel_notified: true } : {}),
    updated_at: new Date().toISOString(),
  }, { onConflict: "game_id" });
}

// ── 시작알림 경로 seam (테스트 주입용) ──────────────────────────────────────
// 프로덕션은 아래 default를 그대로 쓴다. 테스트는 이 seam으로 "앞 경기 FCM 지연 → 뒤 경기
// 시작알림 억제 여부"를 실제 notifyGameStatusTransitions() 실행으로 회귀 검증한다.
export type StartNotifyDeps = {
  storeScheduledSeen?: (gameIds: string[], iso: string) => Promise<void>;
  readStartState?: (
    gameId: string,
  ) => Promise<{
    start_notified: boolean | null;
    last_seen_scheduled_at: string | null;
    start_snapshot_at?: string | null;
  } | null>;
  claimStart?: (gameId: string) => Promise<boolean>;
  unclaimStart?: (gameId: string) => Promise<void>;
  markStart?: (gameId: string) => Promise<void>;
  sendStart?: typeof sendFcmToUsers;
  fansOf?: (teamIds: number[], opts?: { deadlineAtMs?: number }) => Promise<{ ids: string[]; ok: boolean }>;
  deliverStart?: (args: {
    gameId: string;
    teamIds: number[];
    observedAtMs: number;
    payload: { title: string; body: string; url: string };
    attemptDeadlineAtMs?: number;
  }) => Promise<GameStartDeliveryResult>;
  openStart?: (args: GameStartDeliveryTarget) => Promise<number>;
  deliverStartBatch?: (args: GameStartDeliveryTarget & {
    snapshotDeadlineAtMs: number;
    attemptDeadlineAtMs: number;
  }) => Promise<GameStartDeliveryBatchResult>;
  finalizeStart?: (gameId: string, fcmAcceptedDelta?: number) => Promise<GameStartDeliveryResult>;
};

async function defaultStoreScheduledSeen(gameIds: string[], iso: string): Promise<void> {
  // 원자 단조 저장(RPC): last_seen_scheduled_at = GREATEST(existing, observed). 겹친 75초 cron에서
  // 뒤늘게 끝난 이전 invocation의 오래된 관측이 최신 last_seen을 뒤로 덮지 않게 한다
  // (unconditional upsert = last-write-wins 버그, 삼순 #815 재리뷰 blocker).
  // query-guard: bounded -- KBO payload의 scheduled gameIds(당일 경기 ≤10)만 입력, RPC returns void
  const { error } = await supabase.rpc("mark_scheduled_seen", {
    p_game_ids: gameIds,
    p_observed_at: iso,
  });
  if (error) console.error("[game-status] scheduled-seen rpc failed:", error.message);
}

async function defaultReadStartState(
  gameId: string,
): Promise<{
  start_notified: boolean | null;
  last_seen_scheduled_at: string | null;
  start_snapshot_at?: string | null;
} | null> {
  const { data, error } = await supabase
    .from("game_notify_state")
    .select("start_notified, last_seen_scheduled_at, start_snapshot_at")
    .eq("game_id", gameId)
    .abortSignal(AbortSignal.timeout(5_000))
    .maybeSingle();
  if (error) throw new Error(`start state read: ${error.message}`);
  return data ?? null;
}

/**
 * 게임 목록을 보고 시작/종료 알림 발송.
 * - live && start 미발송 → 시작 알림
 * - final && end 미발송 → (start도 미발송이면 cron이 경기 중 못 본 것 — 종료만 발송)
 * - 처음 보는 게임이 이미 final이고 start/end 둘 다 미발송 → 발송 없이 마킹
 *   (배포/도입 직후 과거 경기에 뒷북 알림 방지)
 * - cancelled(isKboGameCancelled) → "경기 취소" 알림 1회(우천 등). 예정시각 +90분 밖이면 마킹만(뒷북 차단).
 */
export async function notifyGameStatusTransitions(
  games: KboRawGame[],
  opts?: {
    /**
     * 이 games payload를 KBO에서 **관측(fetch)한 시각**. 시작알림 90초 게이트의 기준시각.
     * (2026-07-24 사고: 게이트가 경기별 처리 시점 Date.now()를 쓰는 바람에, 같은 틱 안에서
     * 앞 경기 FCM 대량발송 ~26초가 흐른 뒤 처리된 LG:한화가 관측간격 76초인데도 102초로
     * 오판돼 정시 시작알림이 mark-only 억제됨. 게이트는 "직전 틱 예정 관측 → 이번 틱 live
     * 관측"의 연속성을 판정하는 것이므로 관측 시각끼리 비교해야 한다.)
     * 미지정 시 함수 진입 시각으로 1회 캡처(경기별 재측정 금지).
     */
    observedAtMs?: number;
    /** 시작알림 batch가 새 FCM transport를 시작할 수 있는 요청-절대 마감. */
    deadlineAtMs?: number;
    /** game-events가 BoxScore lineup/current batter로 확정한 첫 타석 근거. */
    startPlateAppearanceByGame?: ReadonlyMap<string, StartPlateAppearanceEvidence>;
    /**
     * 시작알림 경로 배선 회귀 테스트용 seam(프로덕션 미지정 → 실제 구현). 앞 경기 FCM 발송
     * 지연이 뒤 경기 시작알림을 억제하지 않는지 이 함수 자체를 실행해 검증하기 위해
     * DB/발송/팬조회를 주입한다(정책 함수 직접호출로는 배선을 잡지 못함, 삼순 리뷰 기준③).
     */
    startDeps?: StartNotifyDeps;
  },
): Promise<{
  started: number;
  ended: number;
  cancelled: number;
}> {
  const observedAtMs = opts?.observedAtMs ?? Date.now();
  const storeScheduledSeen = opts?.startDeps?.storeScheduledSeen ?? defaultStoreScheduledSeen;
  const readStartState = opts?.startDeps?.readStartState ?? defaultReadStartState;
  const claimStart = opts?.startDeps?.claimStart ?? ((gameId: string) => claim(gameId, "start_notified"));
  const unclaimStart = opts?.startDeps?.unclaimStart ?? ((gameId: string) => unclaim(gameId, "start_notified"));
  const markStart = opts?.startDeps?.markStart ?? ((gameId: string) => markOnly(gameId, { start: true }));
  const sendStart = opts?.startDeps?.sendStart ?? sendFcmToUsers;
  const fansOfStart = opts?.startDeps?.fansOf ?? fansOfTeams;
  let started = 0;
  let ended = 0;
  let cancelled = 0;

  // "예정" 상태 관측 기록 — 다음 틱에서 live 전환을 보면 이 시각이 정시성 근거가 된다.
  const scheduledIds = games
    .filter((g) => g.G_ID && g.GAME_STATE_SC === "1" && !isKboGameCancelled(g.CANCEL_SC_ID))
    .map((g) => g.G_ID as string);
  if (scheduledIds.length > 0) {
    // 관측 시각으로 기록 — 다음 틱 게이트가 관측 시각끼리(fetch↔fetch) 간격을 재도록.
    await storeScheduledSeen(scheduledIds, new Date(observedAtMs).toISOString());
  }

  // 프로덕션 ledger 경로는 모든 live 경기 snapshot을 먼저 고정한 뒤 게임별 1 batch씩
  // round-robin한다. 첫 경기의 느린 FCM이 공용 route budget 전체를 독점하지 않게 각
  // transport를 8초로 bound한다. legacy sendStart/deliverStart seam은 기존 테스트만 사용.
  const useFairStartDrain = opts?.startDeps?.sendStart == null && opts?.startDeps?.deliverStart == null;
  const ledgerHandled = new Set<string>();
  if (useFairStartDrain) {
    const openStart = opts?.startDeps?.openStart ?? openGameStartSnapshot;
    const deliverStartBatch = opts?.startDeps?.deliverStartBatch ?? deliverGameStartBatch;
    const finalizeStart = opts?.startDeps?.finalizeStart ?? finalizeGameStartSnapshot;
    const opened: Array<{
      target: GameStartDeliveryTarget;
      snapshotDeadlineAtMs: number;
      acceptedDelta: number;
    }> = [];

    for (const g of games) {
      const gameId = g.G_ID;
      if (!gameId || g.GAME_STATE_SC !== "2" || isKboGameCancelled(g.CANCEL_SC_ID)) continue;
      ledgerHandled.add(gameId);
      let seenRow: Awaited<ReturnType<typeof readStartState>>;
      try {
        seenRow = await readStartState(gameId);
      } catch (error) {
        console.error(`[game-status] start state read failed game=${gameId}:`, (error as Error).message);
        continue;
      }
      if (seenRow?.start_notified) {
        if (seenRow.start_snapshot_at) {
          await finalizeStart(gameId);
        }
        continue;
      }
      const lastSeenMs = seenRow?.last_seen_scheduled_at
        ? Date.parse(seenRow.last_seen_scheduled_at)
        : null;
      const sendOk = Boolean(seenRow?.start_snapshot_at) || shouldSendStartNotification({
        lastSeenScheduledAtMs: Number.isFinite(lastSeenMs as number) ? lastSeenMs : null,
        scheduledStartAtMs: scheduledStartMs(g.G_DT, g.G_TM),
        nowMs: observedAtMs,
        inningNo: g.GAME_INN_NO,
        isTop: g.GAME_TB_SC ? g.GAME_TB_SC === "T" : null,
        // 테스트 seam은 기존 배선 회귀의 첫 타석 fixture를 유지한다. 프로덕션(default deps)은
        // game-events 근거가 없으면 null로 fail-close한다.
        plateAppearance: opts?.startPlateAppearanceByGame?.get(gameId)
          ?? (opts?.startDeps ? { completedPlateAppearances: 0, currentBatterIsLeadoff: true } : null),
      });
      if (!sendOk) {
        await markStart(gameId);
        continue;
      }
      const away = g.AWAY_NM ?? "";
      const home = g.HOME_NM ?? "";
      const teamIds = [teamIdByShortName(away), teamIdByShortName(home)]
        .filter((v): v is number => v !== null);
      const target: GameStartDeliveryTarget = {
        gameId,
        teamIds,
        observedAtMs,
        payload: {
          title: "⚾ 경기 시작!",
          body: `${away} vs ${home} 경기가 시작됐어요. 크보팬에서 자세한 경기 내용을 확인해보세요!`,
          url: `/games/${gameId}`,
        },
      };
      const snapshotDeadlineAtMs = await openStart(target);
      opened.push({ target, snapshotDeadlineAtMs, acceptedDelta: 0 });
    }

    const routeDeadlineAtMs = opts?.deadlineAtMs
      ?? opened.reduce((latest, item) => Math.max(latest, item.snapshotDeadlineAtMs), observedAtMs);
    let active = opened;
    while (active.length > 0 && Date.now() < routeDeadlineAtMs) {
      const round = await Promise.all(active.map(async (item) => {
        const nowMs = Date.now();
        const attemptDeadlineAtMs = Math.min(
          routeDeadlineAtMs,
          item.snapshotDeadlineAtMs,
          nowMs + START_DELIVERY_ATTEMPT_MS,
        );
        if (attemptDeadlineAtMs <= nowMs) return { item, claimed: 0, pending: 0 };
        const batches = await Promise.all(Array.from(
          { length: START_DELIVERY_BATCH_CONCURRENCY_PER_GAME },
          () => deliverStartBatch({
            ...item.target,
            snapshotDeadlineAtMs: item.snapshotDeadlineAtMs,
            attemptDeadlineAtMs,
          }),
        ));
        const claimed = batches.reduce((sum, batch) => sum + batch.claimed, 0);
        const pending = Math.max(...batches.map((batch) => batch.pending), 0);
        item.acceptedDelta += batches.reduce((sum, batch) => sum + batch.fcmAcceptedDelta, 0);
        return { item, claimed, pending };
      }));
      active = round
        .filter(({ claimed, pending }) => claimed > 0 && pending > 0)
        .map(({ item }) => item);
    }

    for (const item of opened) {
      const delivery = await finalizeStart(item.target.gameId, item.acceptedDelta);
      started += delivery.fcmAcceptedDelta;
      console.log(
        `[game-status] start delivery game=${item.target.gameId}` +
        ` fcmAcceptedDelta=${delivery.fcmAcceptedDelta} fcmAcceptedTotal=${delivery.fcmAcceptedTotal}` +
        ` deviceDelivered=${delivery.deviceDelivered ?? "unknown"}` +
        ` pending=${delivery.pending} permanentFailed=${delivery.permanentFailed}` +
        ` expired=${delivery.expired} snapshotCompleted=${delivery.snapshotCompleted}`,
      );
    }
  }

  for (const g of games) {
    const gameId = g.G_ID;
    if (!gameId) continue;
    if (g.GAME_STATE_SC === "2" && ledgerHandled.has(gameId)) continue;

    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const teamIds = [teamIdByShortName(away), teamIdByShortName(home)].filter((v): v is number => v !== null);
    const url = `/games/${gameId}`;

    // 경기 취소 알림 (우천 등). pref는 "game_start"(경기 일정 관심자)에 연계 — 별도 토글 미신설.
    // dedup = cancel_notified 선점. 시작 알림과 달리 +90분 윈도우를 쓰지 않는다 — 우천 지연이
    // 90분을 넘겨 취소되는 "기다리다 취소"가 가장 중요한 알림이라(삼순 #287 블로커1). 대신
    // *과거 날짜*(배포 직후 지난 경기 백필)만 markOnly로 차단하고, 오늘(KST) 이후 경기 취소는 발송.
    if (isKboGameCancelled(g.CANCEL_SC_ID)) {
      const isPastDay = g.G_DT != null && g.G_DT.length === 8 && g.G_DT < kstDateStr();
      if (isPastDay) { await markOnly(gameId, { cancel: true }); continue; }
      if (await claim(gameId, "cancel_notified")) {
        const fans = await fansOfTeams(teamIds);
        if (!fans.ok) { await unclaim(gameId, "cancel_notified"); continue; } // 조회 실패 → 재시도
        const res = await sendFcmToUsers(fans.ids, {
          title: "⚾ 경기 취소",
          body: `${away} vs ${home} 경기가 취소됐어요. 변경된 일정은 크보팬에서 확인해 보세요`,
          url,
        }, "game_start");
        if (!res.ok) { await unclaim(gameId, "cancel_notified"); continue; } // 인프라 실패 → 재시도
        cancelled += res.sent;
        // 30분 전 pregame push(android-widget-live)가 올린 '경기 예정' 카드가 취소 후 잠금화면/
        // 위젯에 잔존하지 않게 clear — data-only game_end로 KboMessagingService가 카드+위젯 제거.
        // cancel_notified 선점 안에서 1회만 발송. 카드 없던 유저에겐 no-op이라 안전. fire-and-forget.
        await sendFcmToUsers(fans.ids, {
          title: "",
          body: "",
          url,
          dataOnly: true,
          // terminal — 위젯 스트림 공통 정책(단일 collapse key + 긴 TTL, 삼순 #649 blocker①).
          ...WIDGET_STREAM.terminal,
          data: { kind: "game_end" },
        }, "game_start");
      }
      continue;
    }

    if (g.GAME_STATE_SC === "2") {
      // 진행 중 — 시작 알림. scheduled→live 전환을 최근 연속 관측한 경우에만 발송하고,
      // 첫 관측이 이미 live(장애 복구·재배포)거나 관측이 stale이면 발송 없이 마킹만.
      // (2026-07-23 하린아빠 지시 "정확한 시간에 가야 하는 알림만" + 삼순 post-merge blocker)
      const seenRow = await readStartState(gameId);
      if (seenRow?.start_notified) continue;
      const lastSeenMs = seenRow?.last_seen_scheduled_at
        ? Date.parse(seenRow.last_seen_scheduled_at)
        : null;
      // 이미 최초 snapshot이 열린 게임은 scheduled→live freshness를 다시 판정하지 않는다.
      // 다음 분 cron은 그 고정 snapshot의 transient/미처리 행만 90초 deadline 안에서 drain한다.
      // 여기서 stale mark-only를 타면 snapshot 완료 전 global start_notified가 닫히는 회귀다.
      const sendOk = Boolean(seenRow?.start_snapshot_at) || shouldSendStartNotification({
        lastSeenScheduledAtMs: Number.isFinite(lastSeenMs as number) ? lastSeenMs : null,
        scheduledStartAtMs: scheduledStartMs(g.G_DT, g.G_TM),
        nowMs: observedAtMs,
        inningNo: g.GAME_INN_NO,
        isTop: g.GAME_TB_SC ? g.GAME_TB_SC === "T" : null,
        plateAppearance: opts?.startPlateAppearanceByGame?.get(gameId)
          ?? (opts?.startDeps ? { completedPlateAppearances: 0, currentBatterIsLeadoff: true } : null),
      });
      if (!sendOk) {
        await markStart(gameId);
        continue;
      }
      // 프로덕션: 최초 eligible device snapshot을 고정한 뒤 token별 ledger+lease로 발송한다.
      // snapshot 전량이 accepted/permanent/expired terminal이 되기 전에는 game 단위
      // start_notified를 닫지 않는다. 신규/교체 토큰은 이후 cron에서 catch-up하지 않는다.
      const deliverStart = opts?.startDeps?.deliverStart
        ?? (opts?.startDeps?.sendStart ? null : deliverGameStartSnapshot);
      if (deliverStart) {
        const delivery = await deliverStart({
          gameId,
          teamIds,
          observedAtMs,
          attemptDeadlineAtMs: opts?.deadlineAtMs,
          payload: {
            title: "⚾ 경기 시작!",
            body: `${away} vs ${home} 경기가 시작됐어요. 크보팬에서 자세한 경기 내용을 확인해보세요!`,
            url,
          },
        });
        started += delivery.fcmAcceptedDelta;
        console.log(
          `[game-status] start delivery game=${gameId}` +
          ` fcmAcceptedDelta=${delivery.fcmAcceptedDelta} fcmAcceptedTotal=${delivery.fcmAcceptedTotal}` +
          ` deviceDelivered=${delivery.deviceDelivered ?? "unknown"}` +
          ` pending=${delivery.pending} permanentFailed=${delivery.permanentFailed}` +
          ` expired=${delivery.expired} snapshotCompleted=${delivery.snapshotCompleted}`,
        );
        continue;
      }
      if (await claimStart(gameId)) {
        const fans = await fansOfStart(teamIds);
        if (!fans.ok) { await unclaimStart(gameId); continue; } // 조회 실패 → 재시도
        const res = await sendStart(fans.ids, {
          title: "⚾ 경기 시작!",
          body: `${away} vs ${home} 경기가 시작됐어요. 크보팬에서 자세한 경기 내용을 확인해보세요!`,
          url,
        }, "game_start");
        if (!res.ok) { await unclaimStart(gameId); continue; } // 인프라 실패 → 재시도
        started += res.sent;
        // 잠금화면 ongoing card 시작 (앱 미진입 자동 표시, C2) — data-only, fire-and-forget.
        // 시작 알림은 이미 성공(started 카운트)이라 카드 실패해도 unclaim 안 함.
        const aScore = parseInt(g.T_SCORE_CN ?? "0") || 0;
        const hScore = parseInt(g.B_SCORE_CN ?? "0") || 0;
        // 위젯(안드로이드)용 구조화 필드 — gameId에서 2자 팀코드 파싱(YYYYMMDD+AWAY+HOME+N).
        const codes = gameId.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
        await sendStart(fans.ids, {
          title: `${away} ${aScore} : ${hScore} ${home}`,
          body: "경기 시작",
          url,
          dataOnly: true,
          // live — 위젯 스트림 공통 정책(90s TTL, 다음 warmup tick이 곧 덮어씀, 삼순 #649 blocker①).
          ...WIDGET_STREAM.live,
          data: {
            kind: "game_live",
            ...(codes ? { w_away: codes[1], w_home: codes[2] } : {}),
            w_as: String(aScore),
            w_hs: String(hScore),
            w_status: "LIVE",
            w_stadium: g.S_NM ?? "",
          },
        }, "game_start");
      }
    } else if (g.GAME_STATE_SC === "3") {
      // 종료 — 한 번도 안 본 게임(시작 미발송)이면 뒷북 방지로 마킹만
      const { data: state } = await supabase
        .from("game_notify_state")
        .select("start_notified, end_notified")
        .eq("game_id", gameId)
        .maybeSingle();
      if (!state || !state.start_notified) {
        await markOnly(gameId, { start: true, end: true });
        continue;
      }
      if (state.end_notified) continue; // 양 슬롯 종료 발송 완료 — 재평가 불필요

      const awayScore = parseInt(g.T_SCORE_CN ?? "0") || 0;
      const homeScore = parseInt(g.B_SCORE_CN ?? "0") || 0;
      const tie = awayScore === homeScore;
      const awayWon = awayScore > homeScore;
      const scoreLine = `${away} ${awayScore} : ${homeScore} ${home}`;

      // streak 표기 — 1순위: 오늘 스냅샷(어제까지 누적) + 이번 결과로 직접 계산 — 순위표
      // 갱신 지연과 무관하게 정확(#cs 2026-07-18 "4연패인데 3연패" fix). 2순위(스냅샷
      // 부재·더블헤더): 라이브 순위표 방향 일치 시에만 노출(기존 fail-closed 유지, 삼순 #210).
      const streaks = await fetchTeamStreaks();
      const snapshotStreaks = await fetchSnapshotStreaks();
      // 오늘 팀별 final 경기 수 — 더블헤더 2차전은 스냅샷이 1차전 결과를 모르므로 폴백 판정용.
      const finalsToday = new Map<number, number>();
      for (const gg of games) {
        if (isKboGameCancelled(gg.CANCEL_SC_ID) || gg.GAME_STATE_SC !== "3") continue;
        for (const nm of [gg.AWAY_NM ?? "", gg.HOME_NM ?? ""]) {
          const id = teamIdByShortName(nm);
          if (id !== null) finalsToday.set(id, (finalsToday.get(id) ?? 0) + 1);
        }
      }
      const streakSuffix = (id: number | null, expected: StreakDir): string => {
        if (id === null) return "";
        const n = decideEndStreakCount({
          snapshotStreak: snapshotStreaks?.get(id),
          hasSnapshot: snapshotStreaks?.has(id) ?? false,
          result: expected,
          finalsToday: finalsToday.get(id) ?? 1,
          liveStreak: streaks.get(id),
        });
        if (n === null) return "";
        return expected === "승" ? ` · ${n}연승!🔥` : ` · ${n}연패 💦`;
      };
      const endCta = "자세한 경기 결과를 크보팬에서 확인해보세요.";

      // away/home 슬롯을 독립 선점·발송 — 한 슬롯 실패가 다른 슬롯을 중복/누락시키지 않음.
      // 한 유저는 team_id 하나라 두 슬롯 수신자는 서로소.
      const slots: Array<{ teamId: number | null; flag: NotifyFlag; isAway: boolean }> = [
        { teamId: teamIdByShortName(away), flag: "end_away_notified", isAway: true },
        { teamId: teamIdByShortName(home), flag: "end_home_notified", isAway: false },
      ];

      for (const slot of slots) {
        if (slot.teamId === null) {
          // 팀 미상 — 보낼 수신자 없음. 슬롯만 마킹해 end_notified 도달 가능하게.
          await supabase.from("game_notify_state")
            .update({ [slot.flag]: true, updated_at: new Date().toISOString() })
            .eq("game_id", gameId);
          continue;
        }
        if (!(await claim(gameId, slot.flag))) continue; // 이미 발송됨

        const fans = await fansOfTeams([slot.teamId]);
        if (!fans.ok) { await unclaim(gameId, slot.flag); continue; }

        let res;
        if (tie) {
          res = await sendFcmToUsers(fans.ids, { title: "🏁 경기 종료", body: `${scoreLine} ${endCta}`, url }, "game_end");
        } else {
          const won = slot.isAway ? awayWon : !awayWon;
          const name = slot.isAway ? away : home;
          res = won
            ? await sendFcmToUsers(fans.ids, { title: `🎉 ${name} 승리!`, body: `${scoreLine}${streakSuffix(slot.teamId, "승")} ${endCta}`, url }, "game_end")
            : await sendFcmToUsers(fans.ids, { title: `🥲 ${name} 아쉬운 패배`, body: `${scoreLine}${streakSuffix(slot.teamId, "패")} ${endCta}`, url }, "game_end");
        }
        if (!res.ok) { await unclaim(gameId, slot.flag); continue; }
        ended += res.sent;
      }

      // 잠금화면 ongoing card 제거 (C2) — data-only, 양팀 팬 모두에게.
      // ⚠️ end_notified=true 마킹보다 *먼저* 보내고, clear가 ok일 때만 마킹으로 넘어간다.
      // 먼저 마킹하면 clear 조회/FCM 실패 시 다음 cron이 end_notified에서 skip → 카드가
      // 잠금화면/위젯에 stale로 stuck. clear는 멱등이라 재시도 안전 (삼순 C2 필수수정).
      const endFans = await fansOfTeams(teamIds);
      let clearOk = endFans.ok;
      if (endFans.ok && endFans.ids.length > 0) {
        const clearRes = await sendFcmToUsers(endFans.ids, {
          title: "",
          body: "",
          dataOnly: true,
          // iOS 무음 백그라운드 wake(content-available) — iOS 홈위젯은 서버 푸시로 직접
          // 갱신되지 않아(플랫폼 제약) 앱을 닫으면 마지막 LIVE 스냅샷에 얼어붙는다. game_end로
          // 앱을 백그라운드에서 깨워 AppDelegate가 홈위젯을 '경기 종료 + 최종 스코어'로 전환
          // (markFinal)하게 한다. 최종 스코어(w_as/w_hs)+gameId 동봉 — 현재 위젯이 이 경기를
          // 표시 중일 때만 반영(다른/다음 경기 덮어쓰기 방지). Android는 KboMessagingService가
          // game_end로 이미 처리하며 apns 블록·추가 필드는 무영향(kind만 사용).
          apnsBackground: true,
          // terminal — 위젯 스트림 공통 정책(단일 collapse key + 긴 TTL, 삼순 #649 blocker①).
          // android 전용 필드라 iOS apns 무음 wake 동작엔 무영향.
          ...WIDGET_STREAM.terminal,
          data: { kind: "game_end", gameId, w_as: String(awayScore), w_hs: String(homeScore) },
        });
        clearOk = clearRes.ok;
      }

      // 두 슬롯 다 발송 + clear ok면 end_notified=true (다음 cron부터 조기 skip).
      // clear 실패 시 미마킹 → 다음 cron이 end 브랜치 재진입해 clear 재시도(슬롯은 이미
      // 선점돼 알림 재발송은 없음).
      if (clearOk) {
        await supabase.from("game_notify_state")
          .update({ end_notified: true, updated_at: new Date().toISOString() })
          .eq("game_id", gameId)
          .eq("end_away_notified", true)
          .eq("end_home_notified", true);
      }
    }
  }

  return { started, ended, cancelled };
}
