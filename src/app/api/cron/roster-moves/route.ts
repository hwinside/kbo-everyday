import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchRegisterRosters } from "@/lib/crawler/kbo-api";
import { diffRoster, type RosterEntry } from "@/lib/roster-moves/parse";

// 팀별 선수 등록/말소 스냅샷 cron (일 2회, KST 오전/저녁 — vercel.json).
// 오늘 등록명단 스냅샷 upsert → 직전 스냅샷 존재 시 diff → roster_moves 멱등 insert.
// 직전 스냅샷이 없으면 baseline만 기록하고 이벤트 0(첫 실행 대량 오탐 방지).
export const dynamic = "force-dynamic";
export const maxDuration = 120; // GET 1 + 구단별 POST 10 + 구단별 upsert

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

    // 직전 스냅샷(오늘 이전 최신 1일) 조회 — diff 입력.
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

    // 오늘 스냅샷 upsert (멱등 — PK(snapshot_date,team_id,kbo_player_id)).
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

    const moves = diffRoster(prev, team.entries);
    if (moves.length > 0) {
      const moveRows = moves.map((m) => ({
        team_id: team.teamId,
        kbo_player_id: m.kboPlayerId,
        player_name: m.playerName,
        move_type: m.moveType,
        move_date: snapshotDate,
      }));
      await admin
        .from("roster_moves")
        .upsert(moveRows, {
          onConflict: "team_id,kbo_player_id,move_type,move_date",
          ignoreDuplicates: true,
        });
    }

    totalMoves += moves.length;
    perTeam.push({
      teamId: team.teamId,
      entries: team.entries.length,
      moves: moves.length,
      baseline: prev === null,
    });
  }

  return NextResponse.json({ ok: true, snapshotDate, totalMoves, perTeam });
}
