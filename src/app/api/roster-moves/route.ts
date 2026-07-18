import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { checkMoveReadiness } from "@/lib/roster-moves/readiness";

// 팀별 최근 등록/말소 조회. 예: /api/roster-moves?teamId=6&days=30
// 준비 완료 게이트: 등록(콜업)은 로스터/에셋 준비된 선수만 노출, 말소는 항상 노출하되
// 준비 안 된 경우 링크만 생략(정보 손실 방지).
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

  const moves = (data ?? []).flatMap((m) => {
    const { ready, canonicalId } = checkMoveReadiness(m.kbo_player_id);
    // 등록(콜업): 온보딩(로스터+에셋) 전이면 링크가 깨지므로 준비될 때까지 노출 보류.
    if (m.move_type === "register" && !ready) return [];
    return [
      {
        kboPlayerId: m.kbo_player_id,
        playerName: m.player_name,
        moveType: m.move_type as "register" | "deregister",
        moveDate: m.move_date,
        // 말소는 준비 안 됐어도 노출하되 링크만 생략.
        href: canonicalId ? `/community/players/${canonicalId}` : null,
      },
    ];
  });

  return NextResponse.json({ teamId, days, moves });
}
