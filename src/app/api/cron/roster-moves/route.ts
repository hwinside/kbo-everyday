import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchRegisterRosters, RosterCollectionError } from "@/lib/crawler/kbo-api";
import { planTeamMoves, type RosterEntry } from "@/lib/roster-moves/parse";
import { checkPublishReadiness } from "@/lib/roster-moves/readiness";
import {
  notifyPendingMoves,
  notifyCollectionFailure,
  type PendingMove,
} from "@/lib/roster-moves/pending-alert";

// 팀별 선수 등록/말소 스냅샷 cron (일 2회, KST 오전/저녁 — vercel.json).
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

function authorized(req: NextRequest): boolean {
  // fail-closed — env 미설정이면 전부 거부
  return Boolean(CRON_SECRET) && req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

/** "20260718" → "2026-07-18" (Postgres DATE 리터럴). */
function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ⓪ 수집 — 실패(HTTP/토큰/날짜/인원수)는 DB를 건드리기 전에 fail-closed.
  let date: string;
  let teams: { teamId: number; teamCode: string; entries: RosterEntry[] }[];
  try {
    const result = await fetchRegisterRosters();
    date = result.date;
    teams = result.teams;
  } catch (e) {
    const msg = e instanceof RosterCollectionError ? e.message : String(e);
    await notifyCollectionFailure(msg);
    console.error(`[roster-moves] 수집 실패 — 스냅샷 불변, 5xx fail-closed: ${msg}`);
    return NextResponse.json({ ok: false, stage: "collect", error: msg }, { status: 502 });
  }

  const admin = getSupabaseAdmin();
  const snapshotDate = toIsoDate(date);
  // stale run 역순 커밋 차단(삼순 P0/P1 3차): 이번 run의 KBO 수집 완료 시각을 모든 팀 RPC에 같이 넘긴다.
  // 나중에 수집(=더 최신)한 run이 항상 이기도록, RPC가 저장된 capture보다 오래된 쓰기를 거부한다.
  const capturedAt = new Date().toISOString();

  let totalMoves = 0;
  let staleSkipped = 0;
  const perTeam: { teamId: number; entries: number; moves: number; baseline: boolean; applied: boolean }[] = [];

  for (const team of teams) {
    // 직전 "일자" 스냅샷(오늘 이전 최신 1일) 조회 — diff 기준점.
    // 같은 날 2회차 실행도 동일 기준(전일)으로 오늘 이벤트 집합을 전체 재계산한다.
    const { data: prevDateRow, error: prevDateErr } = await admin
      .from("roster_snapshots")
      .select("snapshot_date")
      .eq("team_id", team.teamId)
      .lt("snapshot_date", snapshotDate)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prevDateErr) {
      return failClosed("read-prev-date", team.teamId, prevDateErr.message);
    }

    let prev: RosterEntry[] | null = null;
    if (prevDateRow) {
      const { data: prevRows, error: prevRowsErr } = await admin
        .from("roster_snapshots")
        .select("kbo_player_id, player_name, back_no, position")
        .eq("team_id", team.teamId)
        .eq("snapshot_date", prevDateRow.snapshot_date);
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

    // ── 오늘 스냅샷+무브 원자 교체: 단일 RPC 트랜잭션(advisory lock + captured_at 워터마크).
    // 마이그레이션 미적용/함수 미존재/제약 위반은 모두 error로 돌아와 여기서 5xx fail-closed.
    const { data: rpcData, error: rpcErr } = await admin.rpc("replace_team_roster_day", {
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
    });
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
      baseline: prev === null,
      applied,
    });
  }

  // ── 승격 단계: pending 등록 전건 재검사 → 전체 통과 시 published.
  // 미통과 건은 응답 + 슬랙으로 반드시 표면화(silent omission 금지 — 삼순 P0).
  const { data: pendingRows, error: pendingErr } = await admin
    .from("roster_moves")
    .select("id, team_id, kbo_player_id, player_name, move_date")
    .eq("status", "pending")
    .order("move_date", { ascending: true });
  if (pendingErr) {
    return failClosed("read-pending", 0, pendingErr.message);
  }

  let promoted = 0;
  const pending: PendingMove[] = [];
  for (const row of pendingRows ?? []) {
    const readiness = await checkPublishReadiness(row.kbo_player_id);
    if (readiness.ready && readiness.canonicalId) {
      // published 등록 링크 불변식(삼순 P0 3차): 승격 시 검증한 canonical id를 함께 저장한다
      // → 조회 시점에 raw id 재resolve 없이 href를 항상 non-null로 생성한다.
      const { error: updErr } = await admin
        .from("roster_moves")
        .update({ status: "published", canonical_id: readiness.canonicalId })
        .eq("id", row.id);
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

  const { status: pendingAlert } = await notifyPendingMoves(pending);
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

/** DB 오류 시 5xx fail-closed 응답 — 스냅샷/무브는 RPC 트랜잭션 롤백으로 불변. */
function failClosed(stage: string, teamId: number, message: string): NextResponse {
  console.error(`[roster-moves] DB 실패 stage=${stage} team=${teamId}: ${message} — 5xx fail-closed`);
  return NextResponse.json({ ok: false, stage, teamId, error: message }, { status: 500 });
}
