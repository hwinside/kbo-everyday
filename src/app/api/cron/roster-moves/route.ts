import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  fetchGames,
  fetchRegisterRosters,
  REGISTER_COLLECTION_DEADLINE_MS,
  RosterCollectionError,
} from "@/lib/crawler/kbo-api";
import { planTeamMoves, type RosterEntry } from "@/lib/roster-moves/parse";
import { checkPublishReadiness } from "@/lib/roster-moves/readiness";
import { runBeforeDeadline } from "@/lib/async-deadline";
import { getKSTToday } from "@/lib/utils/date-kst";
import {
  getPregameRosterMovesDecision,
  isDailyRosterMovesWindow,
} from "@/lib/roster-moves/schedule";
import {
  notifyPendingMoves,
  notifyCollectionFailure,
  type PendingMove,
} from "@/lib/roster-moves/pending-alert";

// 팀별 선수 등록/말소 스냅샷 cron (매일 10:00 KST + 경기일 첫 경기 2시간 전 — vercel.json).
//
// 실행 흐름 (2026-07-18 삼순 P0/P1 2차 반영):
// ⓪ 수집: KBO 공식 등록명단을 10구단 전부 수집(HTTP status/토큰/날짜/인원수 sanity 검증).
//    한 팀이라도 실패하면 예외 → DB 미변경 + 5xx + 운영 알림(silent success 제거).
// ① 팀별: 직전 "일자" 스냅샷 대비 diff → 오늘 스냅샷/무브를 **단일 RPC 트랜잭션**으로 원자 교체
//    (advisory lock으로 동시 2회 실행 경합 차단, 함수 내 트랜잭션으로 부분 상태 제거).
//    등록 무브는 pending으로 생성(공개 게이트), 말소는 즉시 published.
// ② 승격: pending 등록 전건 readiness 재검사(canonical resolve + 프로필 JPG/히어로 WEBP 실측 200
//    + 서버 신호 상세 존재) → 통과 시 published 승격. 미통과는 응답 pending 목록 + 슬랙 알림.
// 모든 DB 호출은 { error } 확인 → 실패 시 5xx fail-closed(스냅샷/무브 불변).
// 직전 일자 스냅샷이 없으면 baseline만 기록하고 이벤트 0(첫 실행 대량 오탐 방지).
export const dynamic = "force-dynamic";
export const maxDuration = 120; // GET 1 + 구단별 POST 10 + RPC 10 + pending 승격 검사(소수 건 HTTP)

const CRON_SECRET = process.env.CRON_SECRET || "";
const PENDING_READINESS_LIMIT = 500;

function authorized(req: NextRequest): boolean {
  // fail-closed — env 미설정이면 전부 거부
  return Boolean(CRON_SECRET) && req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

export type RosterMovesRouteDeps = {
  now: () => Date;
  fetchImpl: typeof fetch;
  fetchGamesImpl: typeof fetchGames;
  fetchRegisterRostersImpl: typeof fetchRegisterRosters;
  getSupabaseAdminImpl: typeof getSupabaseAdmin;
  notifyCollectionFailureImpl: typeof notifyCollectionFailure;
  notifyPendingMovesImpl: typeof notifyPendingMoves;
  checkPublishReadinessImpl: typeof checkPublishReadiness;
  collectionDeadlineMs: number;
};

const DEFAULT_DEPS: RosterMovesRouteDeps = {
  now: () => new Date(),
  fetchImpl: fetch,
  fetchGamesImpl: fetchGames,
  fetchRegisterRostersImpl: fetchRegisterRosters,
  getSupabaseAdminImpl: getSupabaseAdmin,
  notifyCollectionFailureImpl: notifyCollectionFailure,
  notifyPendingMovesImpl: notifyPendingMoves,
  checkPublishReadinessImpl: checkPublishReadiness,
  collectionDeadlineMs: REGISTER_COLLECTION_DEADLINE_MS,
};

/** "20260718" → "2026-07-18" (Postgres DATE 리터럴). */
function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function routeAbortSignal(deadlineAtMs: number): AbortSignal {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) return AbortSignal.abort(new Error("deadline_exceeded"));
  // Abort the transport slightly before the outer completion backstop so the
  // route never returns while a PostgREST/fetch request is still outstanding.
  const settleReserveMs = Math.min(25, Math.max(1, Math.floor(remainingMs / 10)));
  return AbortSignal.timeout(Math.max(1, remainingMs - settleReserveMs));
}

export async function rosterMovesRoute(
  req: NextRequest,
  depsOverride: Partial<RosterMovesRouteDeps> = {},
) {
  const deps: RosterMovesRouteDeps = { ...DEFAULT_DEPS, ...depsOverride };
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // One wall-clock budget covers schedule discovery, collection and asset
  // readiness. A later stage must never receive a fresh independent timeout.
  const routeDeadlineAtMs = Date.now() + deps.collectionDeadlineMs;

  // 30분 tick 중 실제 수집은 매일 10시와 당일 첫 경기 2시간 전에만 실행한다.
  // 운영 수동 실행은 인증된 ?force=1로 시간 게이트를 우회할 수 있다.
  const now = deps.now();
  if (req.nextUrl.searchParams.get("force") !== "1" && !isDailyRosterMovesWindow(now)) {
    let games;
    try {
      games = await runBeforeDeadline(
        () => deps.fetchGamesImpl(
          getKSTToday().replaceAll("-", ""),
          undefined,
          {
            timeoutMs: Math.max(1, routeDeadlineAtMs - Date.now()),
            deadlineAtMs: routeDeadlineAtMs,
          },
        ),
        routeDeadlineAtMs,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[roster-moves] 경기일정 확인 실패: ${message}`);
      return NextResponse.json(
        { ok: false, stage: "schedule", error: message },
        { status: 502 },
      );
    }

    const decision = getPregameRosterMovesDecision(games, now);
    if (!decision.run) {
      return NextResponse.json({ ok: true, skipped: true, ...decision });
    }
  }

  // ── run ordering 워터마크는 수집 *시작 전*에 고정한다 (삼순 P0/P1 4차).
  //   fetchRegisterRosters는 GET 1 + 팀별 POST 10회를 순차 실행해 수 초~수십 초 걸린다.
  //   이 타임스탬프를 수집 *완료 후*에 찍으면, 먼저 시작했지만 늦게 끝난 run A의 값이 나중에
  //   시작해 먼저 끝난 run B보다 커져(늦게 완료=더 큰 값) B를 덮는다(later-started run이 져야
  //   하는데 이김). 시작 시각으로 고정하면 RPC 워터마크 비교가 "나중에 시작한 run이 항상 이긴다"를
  //   보장한다(수집 소요와 무관).
  const runStartedAt = deps.now().toISOString();

  // ⓪ 수집 — 실패(HTTP/토큰/날짜/인원수/적용일 freshness)는 DB를 건드리기 전에 fail-closed.
  let date: string;
  let teams: { teamId: number; teamCode: string; entries: RosterEntry[] }[];
  try {
    const result = await deps.fetchRegisterRostersImpl({
      deadlineAtMs: routeDeadlineAtMs,
      fetchImpl: deps.fetchImpl,
    });
    date = result.date;
    teams = result.teams;
  } catch (e) {
    const msg = e instanceof RosterCollectionError ? e.message : String(e);
    // 관제 실패가 이미 종료된 수집 deadline 뒤에서 cron 응답을 다시 붙잡지 않도록 분리한다.
    // 실제 notifier 자체도 AbortSignal timeout으로 outstanding request를 회수한다.
    void deps.notifyCollectionFailureImpl(msg).catch(() => undefined);
    console.error(`[roster-moves] 수집 실패 — 스냅샷 불변, 5xx fail-closed: ${msg}`);
    return NextResponse.json({ ok: false, stage: "collect", error: msg }, { status: 502 });
  }

  const admin = deps.getSupabaseAdminImpl();
  const snapshotDate = toIsoDate(date);
  // stale run 역순 커밋 차단(삼순 P0/P1 3차+4차): 수집 시작 전에 고정한 runStartedAt을 모든 팀 RPC에
  // 워터마크로 넘긴다. RPC는 저장된 값보다 오래되거나 같은 쓰기를 거부한다 → 나중에 시작한 run이 항상 이긴다.
  const capturedAt = runStartedAt;

  const preparedTeams: Array<{
    team: (typeof teams)[number];
    planned: ReturnType<typeof planTeamMoves>;
    baseline: boolean;
  }> = [];
  for (const team of teams) {
    // 직전 "일자" 스냅샷(오늘 이전 최신 1일) 조회 — diff 기준점.
    // 같은 날 2회차 실행도 동일 기준(전일)으로 오늘 이벤트 집합을 전체 재계산한다.
    let prevDateResult;
    try {
      const remainingMs = routeDeadlineAtMs - Date.now();
      if (remainingMs <= 0) throw new Error("deadline_exceeded");
      prevDateResult = await runBeforeDeadline(
        () => admin
          .from("roster_snapshots")
          .select("snapshot_date")
          .eq("team_id", team.teamId)
          .lt("snapshot_date", snapshotDate)
          .order("snapshot_date", { ascending: false })
          .limit(1)
          .abortSignal(routeAbortSignal(routeDeadlineAtMs))
          .maybeSingle(),
        routeDeadlineAtMs,
      );
    } catch (error) {
      return deadlineFailClosed("read-prev-date", error);
    }
    const { data: prevDateRow, error: prevDateErr } = prevDateResult;
    if (prevDateErr) {
      return failClosed("read-prev-date", team.teamId, prevDateErr.message);
    }

    let prev: RosterEntry[] | null = null;
    if (prevDateRow) {
      let prevRowsResult;
      try {
        const remainingMs = routeDeadlineAtMs - Date.now();
        if (remainingMs <= 0) throw new Error("deadline_exceeded");
        // query-guard: bounded -- exact team/date roster snapshot is capped by the KBO active roster.
        prevRowsResult = await runBeforeDeadline(
          () => admin
            .from("roster_snapshots")
            .select("kbo_player_id, player_name, back_no, position")
            .eq("team_id", team.teamId)
            .eq("snapshot_date", prevDateRow.snapshot_date)
            .abortSignal(routeAbortSignal(routeDeadlineAtMs)),
          routeDeadlineAtMs,
        );
      } catch (error) {
        return deadlineFailClosed("read-prev-rows", error);
      }
      const { data: prevRows, error: prevRowsErr } = prevRowsResult;
      if (prevRowsErr) {
        return failClosed("read-prev-rows", team.teamId, prevRowsErr.message);
      }
      prev = (prevRows ?? []).map((r) => ({
        kboId: r.kbo_player_id,
        name: r.player_name,
        backNo: r.back_no ?? "",
        position: r.position ?? "",
      }));
    }

    const planned = planTeamMoves(prev, team.entries);
    preparedTeams.push({ team, planned, baseline: prev === null });
  }

  // Resolve every readiness probe before the first mutating RPC. That keeps a
  // stalled asset endpoint from committing only part of today's snapshot/move
  // set. Include registrations planned by this run so newly inserted pending
  // rows can be promoted from the same preflight result without post-write I/O.
  // query-guard: bounded -- pending readiness preflight is capped at 501 and fails closed above 500.
  let existingPendingResult;
  try {
    const remainingMs = routeDeadlineAtMs - Date.now();
    if (remainingMs <= 0) throw new Error("deadline_exceeded");
    // query-guard: bounded -- pending readiness preflight is capped at 501 and fails closed above 500.
    existingPendingResult = await runBeforeDeadline(
      () => admin
        .from("roster_moves")
        .select("id, team_id, kbo_player_id, player_name, move_date")
        .eq("status", "pending")
        .order("move_date", { ascending: true })
        .limit(PENDING_READINESS_LIMIT + 1)
        .abortSignal(routeAbortSignal(routeDeadlineAtMs)),
      routeDeadlineAtMs,
    );
  } catch (error) {
    return deadlineFailClosed("read-pending", error);
  }
  const { data: existingPendingRows, error: existingPendingErr } = existingPendingResult;
  if (existingPendingErr) {
    return failClosed("read-pending", 0, existingPendingErr.message);
  }
  if ((existingPendingRows?.length ?? 0) > PENDING_READINESS_LIMIT) {
    return failClosed("read-pending-overflow", 0, `pending>${PENDING_READINESS_LIMIT}`);
  }

  const readinessIds = new Set<string>(
    (existingPendingRows ?? []).map((row) => row.kbo_player_id),
  );
  for (const { planned } of preparedTeams) {
    for (const move of planned) {
      if (move.moveType === "register") readinessIds.add(move.kboPlayerId);
    }
  }

  const readinessById = new Map<string, Awaited<ReturnType<typeof checkPublishReadiness>>>();
  for (const playerId of readinessIds) {
    try {
      readinessById.set(
        playerId,
        await runBeforeDeadline(
          () => deps.checkPublishReadinessImpl(
            playerId,
            undefined,
            routeDeadlineAtMs,
          ),
          routeDeadlineAtMs,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        { ok: false, stage: "readiness", error: message },
        { status: 502 },
      );
    }
  }

  let totalMoves = 0;
  let staleSkipped = 0;
  const perTeam: { teamId: number; entries: number; moves: number; baseline: boolean; applied: boolean }[] = [];
  for (const { team, planned, baseline } of preparedTeams) {

    // ── 오늘 스냅샷+무브 원자 교체: 단일 RPC 트랜잭션(advisory lock + captured_at 워터마크).
    // 마이그레이션 미적용/함수 미존재/제약 위반은 모두 error로 돌아와 여기서 5xx fail-closed.
    let rpcResult;
    try {
      // Check again immediately before the first write. A DB/readiness task
      // that consumed the budget must never allow even one mutating RPC.
      const remainingMs = routeDeadlineAtMs - Date.now();
      if (remainingMs <= 0) throw new Error("deadline_exceeded");
      rpcResult = await runBeforeDeadline(
        () => admin.rpc("replace_team_roster_day", {
          p_team_id: team.teamId,
          p_snapshot_date: snapshotDate,
          p_entries: team.entries.map((e) => ({
            kboId: e.kboId,
            name: e.name,
            backNo: e.backNo,
            position: e.position,
          })),
          p_moves: planned.map((m) => ({
            kboPlayerId: m.kboPlayerId,
            playerName: m.playerName,
            moveType: m.moveType,
            status: m.status,
          })),
          p_captured_at: capturedAt,
        }).abortSignal(routeAbortSignal(routeDeadlineAtMs)),
        routeDeadlineAtMs,
      );
    } catch (error) {
      return deadlineFailClosed("replace-team-roster-day", error);
    }
    const { data: rpcData, error: rpcErr } = rpcResult;
    if (rpcErr) {
      return failClosed("replace-team-roster-day", team.teamId, rpcErr.message);
    }

    // applied=false = 이미 더 최신 run이 썼다(stale 역순 커밋 거부). 오류 아니므로 5xx 아니고 카운트에서 제외.
    const applied = (rpcData as { applied?: boolean } | null)?.applied !== false;
    if (!applied) {
      staleSkipped++;
      console.warn(
        `[roster-moves] team=${team.teamId} stale capture 거부(이미 더 최신 run이 쓴 스냅샷 존재) — 이번 쓰기 no-op`,
      );
    } else {
      totalMoves += planned.length;
    }
    perTeam.push({
      teamId: team.teamId,
      entries: team.entries.length,
      moves: applied ? planned.length : 0,
      baseline,
      applied,
    });
  }

  // ── 승격 단계: pending 등록 전건 재검사 → 전체 통과 시 published.
  // 미통과 건은 응답 + 슬랙으로 반드시 표면화(silent omission 금지 — 삼순 P0).
  // query-guard: bounded -- post-RPC pending verification is capped at 501 and fails closed above 500.
  let pendingResult;
  try {
    const remainingMs = routeDeadlineAtMs - Date.now();
    if (remainingMs <= 0) throw new Error("deadline_exceeded");
    // query-guard: bounded -- post-RPC pending verification is capped at 501 and fails closed above 500.
    pendingResult = await runBeforeDeadline(
      () => admin
        .from("roster_moves")
        .select("id, team_id, kbo_player_id, player_name, move_date")
        .eq("status", "pending")
        .order("move_date", { ascending: true })
        .limit(PENDING_READINESS_LIMIT + 1)
        .abortSignal(routeAbortSignal(routeDeadlineAtMs)),
      routeDeadlineAtMs,
    );
  } catch (error) {
    return deadlineFailClosed("read-pending-post-rpc", error);
  }
  const { data: pendingRows, error: pendingErr } = pendingResult;
  if (pendingErr) {
    return failClosed("read-pending", 0, pendingErr.message);
  }
  if ((pendingRows?.length ?? 0) > PENDING_READINESS_LIMIT) {
    return failClosed("read-pending-overflow", 0, `pending>${PENDING_READINESS_LIMIT}`);
  }

  let promoted = 0;
  const pending: PendingMove[] = [];
  for (const row of pendingRows ?? []) {
    const readiness = readinessById.get(row.kbo_player_id);
    // A row introduced concurrently after preflight is never promoted without
    // its own successful probe; it remains pending for the next bounded run.
    if (!readiness) {
      pending.push({
        playerName: row.player_name,
        teamId: row.team_id,
        moveDate: row.move_date,
        missing: ["readiness-unverified"],
      });
      continue;
    }
    if (readiness.ready && readiness.canonicalId) {
      // published 등록 링크 불변식(삼순 P0 3차): 승격 시 검증한 canonical id를 함께 저장한다
      // → 조회 시점에 raw id 재resolve 없이 href를 항상 non-null로 생성한다.
      let updateResult;
      try {
        const remainingMs = routeDeadlineAtMs - Date.now();
        if (remainingMs <= 0) throw new Error("deadline_exceeded");
        updateResult = await runBeforeDeadline(
          () => admin
            .from("roster_moves")
            .update({ status: "published", canonical_id: readiness.canonicalId })
            .eq("id", row.id)
            .abortSignal(routeAbortSignal(routeDeadlineAtMs)),
          routeDeadlineAtMs,
        );
      } catch (error) {
        return deadlineFailClosed("promote-update", error);
      }
      const { error: updErr } = updateResult;
      if (updErr) {
        return failClosed("promote-update", row.team_id, updErr.message);
      }
      promoted++;
    } else {
      pending.push({
        playerName: row.player_name,
        teamId: row.team_id,
        moveDate: row.move_date,
        missing: readiness.missing,
      });
    }
  }

  let pendingAlert: Awaited<ReturnType<typeof notifyPendingMoves>>["status"];
  try {
    const result = await runBeforeDeadline(
      () => deps.notifyPendingMovesImpl(pending, { deadlineAtMs: routeDeadlineAtMs }),
      routeDeadlineAtMs,
    );
    pendingAlert = result.status;
  } catch {
    pendingAlert = "webhook-error";
  }
  if (pending.length > 0 && pendingAlert !== "sent") {
    // env 부재/전송 실패여도 silent 금지 — 로그 + 응답 pending으로 추적 가능하게 남긴다.
    console.warn(
      `[roster-moves] 공개 대기 pending ${pending.length}건 (알림 상태: ${pendingAlert}) — ` +
        pending.map((p) => `${p.playerName}[${p.missing.join(",")}]`).join(", "),
    );
  }

  return NextResponse.json({
    ok: true,
    snapshotDate,
    totalMoves,
    staleSkipped,
    promoted,
    pending,
    pendingAlert,
    perTeam,
  });
}

export async function GET(req: NextRequest) {
  return rosterMovesRoute(req);
}

/** DB 오류 시 5xx fail-closed 응답 — 스냅샷/무브는 RPC 트랜잭션 롤백으로 불변. */
function failClosed(stage: string, teamId: number, message: string): NextResponse {
  console.error(`[roster-moves] DB 실패 stage=${stage} team=${teamId}: ${message} — 5xx fail-closed`);
  return NextResponse.json({ ok: false, stage, teamId, error: message }, { status: 500 });
}

function deadlineFailClosed(stage: string, error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[roster-moves] deadline 실패 stage=${stage}: ${message} — 후속 DB/RPC 중단`);
  return NextResponse.json({ ok: false, stage, error: message }, { status: 502 });
}
