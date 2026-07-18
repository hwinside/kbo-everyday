import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchRegisterRosters } from "@/lib/crawler/kbo-api";
import { planTeamMoves, type RosterEntry } from "@/lib/roster-moves/parse";
import { checkPublishReadiness } from "@/lib/roster-moves/readiness";
import { notifyPendingMoves, type PendingMove } from "@/lib/roster-moves/pending-alert";

// 팀별 선수 등록/말소 스냅샷 cron (일 2회, KST 오전/저녁 — vercel.json).
//
// 실행 흐름 (2026-07-18 삼순 P0/P1 반영):
// ① 팀별: 직전 "일자" 스냅샷 대비 diff → 오늘 스냅샷/무브를 **원자적 교체**
//    (upsert 후 stale row 삭제 — 같은 날 2회차 실행이 오전 잔존 row를 남기던 P1 중복 말소 제거).
//    등록 무브는 pending으로 생성(공개 게이트), 말소는 즉시 published.
// ② 승격: pending 등록 전건 readiness 재검사(roster+photo+hero+상세페이지 prod 200)
//    → 통과 시 published 승격. 미통과는 응답 pending 목록 + 슬랙 알림(silent omission 금지).
// 직전 일자 스냅샷이 없으면 baseline만 기록하고 이벤트 0(첫 실행 대량 오탐 방지).
export const dynamic = "force-dynamic";
export const maxDuration = 120; // GET 1 + 구단별 POST 10 + 구단별 저장 + pending 승격 검사(소수 건 HTTP)

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

  const admin = getSupabaseAdmin();
  const { date, teams } = await fetchRegisterRosters();
  const snapshotDate = toIsoDate(date);

  let totalMoves = 0;
  const perTeam: { teamId: number; entries: number; moves: number; baseline: boolean }[] = [];

  for (const team of teams) {
    if (team.entries.length === 0) {
      // 파싱 실패/빈 응답 — 스냅샷을 비우면 다음 실행에서 전원 말소 오탐. 이번 회차 스킵.
      perTeam.push({ teamId: team.teamId, entries: 0, moves: 0, baseline: false });
      continue;
    }

    // 직전 "일자" 스냅샷(오늘 이전 최신 1일) 조회 — diff 기준점.
    // 같은 날 2회차 실행도 동일 기준(전일)으로 오늘 이벤트 집합을 전체 재계산한다.
    const { data: prevDateRow } = await admin
      .from("roster_snapshots")
      .select("snapshot_date")
      .eq("team_id", team.teamId)
      .lt("snapshot_date", snapshotDate)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    let prev: RosterEntry[] | null = null;
    if (prevDateRow) {
      const { data: prevRows } = await admin
        .from("roster_snapshots")
        .select("kbo_player_id, player_name, back_no, position")
        .eq("team_id", team.teamId)
        .eq("snapshot_date", prevDateRow.snapshot_date);
      prev = (prevRows ?? []).map((r) => ({
        kboId: r.kbo_player_id,
        name: r.player_name,
        backNo: r.back_no ?? "",
        position: r.position ?? "",
      }));
    }

    const planned = planTeamMoves(prev, team.entries);
    const currIds = new Set(team.entries.map((e) => e.kboId));

    // ── 오늘 스냅샷 원자적 교체: upsert 먼저(빈 스냅샷 창 방지) → stale row 삭제.
    // 같은 날 오전 [A,B] → 저녁 [A]이면 B row를 지워, 다음 날 diff가 B를 재말소(P1 중복)하지 않게 한다.
    const { data: todaySnapRows } = await admin
      .from("roster_snapshots")
      .select("kbo_player_id")
      .eq("team_id", team.teamId)
      .eq("snapshot_date", snapshotDate);
    const snapshotRows = team.entries.map((e) => ({
      snapshot_date: snapshotDate,
      team_id: team.teamId,
      kbo_player_id: e.kboId,
      player_name: e.name,
      back_no: e.backNo,
      position: e.position,
    }));
    await admin
      .from("roster_snapshots")
      .upsert(snapshotRows, { onConflict: "snapshot_date,team_id,kbo_player_id" });
    const staleSnapIds = (todaySnapRows ?? [])
      .map((r) => r.kbo_player_id)
      .filter((id) => !currIds.has(id));
    if (staleSnapIds.length > 0) {
      await admin
        .from("roster_snapshots")
        .delete()
        .eq("team_id", team.teamId)
        .eq("snapshot_date", snapshotDate)
        .in("kbo_player_id", staleSnapIds);
    }

    // ── 오늘 무브 원자적 교체: 계획 집합 upsert(기존 row status 보존) → 집합 밖 row 삭제.
    // ignoreDuplicates=ON CONFLICT DO NOTHING — 오전에 published 승격된 등록이 저녁 재계산으로
    // pending으로 강등되지 않는다. 삭제는 당일 왕복(등록 후 당일 말소) 등 재계산 집합에서
    // 빠진 이벤트 제거 — 일 단위 계약상 순변동만 남긴다.
    const { data: todayMoveRows } = await admin
      .from("roster_moves")
      .select("id, kbo_player_id, move_type")
      .eq("team_id", team.teamId)
      .eq("move_date", snapshotDate);
    if (planned.length > 0) {
      const moveRows = planned.map((m) => ({
        team_id: team.teamId,
        kbo_player_id: m.kboPlayerId,
        player_name: m.playerName,
        move_type: m.moveType,
        move_date: snapshotDate,
        status: m.status,
      }));
      await admin
        .from("roster_moves")
        .upsert(moveRows, {
          onConflict: "team_id,kbo_player_id,move_type,move_date",
          ignoreDuplicates: true,
        });
    }
    const plannedKeys = new Set(planned.map((m) => `${m.kboPlayerId}|${m.moveType}`));
    const staleMoveIds = (todayMoveRows ?? [])
      .filter((r) => !plannedKeys.has(`${r.kbo_player_id}|${r.move_type}`))
      .map((r) => r.id);
    if (staleMoveIds.length > 0) {
      await admin.from("roster_moves").delete().in("id", staleMoveIds);
    }

    totalMoves += planned.length;
    perTeam.push({
      teamId: team.teamId,
      entries: team.entries.length,
      moves: planned.length,
      baseline: prev === null,
    });
  }

  // ── 승격 단계: pending 등록 전건 재검사 → 전체 통과 시 published.
  // 미통과 건은 응답 + 슬랙으로 반드시 표면화(silent omission 금지 — 삼순 P0).
  const { data: pendingRows } = await admin
    .from("roster_moves")
    .select("id, team_id, kbo_player_id, player_name, move_date")
    .eq("status", "pending")
    .order("move_date", { ascending: true });

  let promoted = 0;
  const pending: PendingMove[] = [];
  for (const row of pendingRows ?? []) {
    const readiness = await checkPublishReadiness(row.kbo_player_id);
    if (readiness.ready) {
      await admin.from("roster_moves").update({ status: "published" }).eq("id", row.id);
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
    promoted,
    pending,
    pendingAlert,
    perTeam,
  });
}
