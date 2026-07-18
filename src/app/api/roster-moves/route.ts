import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { checkMoveReadiness, moveHref } from "@/lib/roster-moves/readiness";

// 팀별 최근 등록/말소 조회. 예: /api/roster-moves?teamId=6&days=30
// 노출 계약(2026-07-18 정정): 등록/말소 전부 항상 노출 — 숨김 게이트 없음.
// readiness(로스터 SSOT+에셋)는 선수 상세 링크 유무만 결정(미준비 = 링크 생략).
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const teamId = Number(searchParams.get("teamId"));
  const days = Math.min(Math.max(Number(searchParams.get("days")) || 30, 1), 90);
  if (!teamId) {
    return NextResponse.json({ error: "teamId required" }, { status: 400 });
  }

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("roster_moves")
    .select("kbo_player_id, player_name, move_type, move_date")
    .eq("team_id", teamId)
    .gte("move_date", sinceStr)
    .order("move_date", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const moves = (data ?? []).map((m) => ({
    kboPlayerId: m.kbo_player_id,
    playerName: m.player_name,
    moveType: m.move_type as "register" | "deregister",
    moveDate: m.move_date,
    // 미준비 선수는 링크만 생략(말소 처리와 동일 패턴) — 항목 자체는 항상 노출.
    href: moveHref(checkMoveReadiness(m.kbo_player_id)),
  }));

  return NextResponse.json({ teamId, days, moves });
}
