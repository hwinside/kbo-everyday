import { NextRequest, NextResponse } from "next/server";
import { resolvePlayer } from "@/lib/utils/resolve-player";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * 선수 경기별 로그 (선수 스탯 보강 V1 — 빌드 2: 경기별 탭).
 * spec: specs/stats/player-stats-v1.md §5-1
 *
 * GET /api/player-game-logs?id=<kboId|raw>&pos=<position>
 *   - id: canonical kboId / 숫자 kboId / 레거시 pN 모두 resolvePlayer로 정규화
 *   - pos: "투수" → player_type='pitcher', 그 외 → 'batter'
 *   - 응답: game_date 오름차순(시즌누적 AVG/ERA 계산 자연스럽게). 호출부에서 표시 정렬.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawId = searchParams.get("id");
  const pos = searchParams.get("pos") ?? "";
  if (!rawId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const resolved = resolvePlayer(rawId);
  const kboId = resolved?.kboId ?? rawId;
  const playerType = pos === "투수" ? "pitcher" : "batter";

  const { data, error } = await supabaseAdmin
    .from("player_game_logs")
    .select(
      "game_id, game_date, team_code, opponent_team_id, is_home, result, ab, h, hr, rbi, bb, so, ip_outs, er, h_allowed, k, bb_allowed",
    )
    .eq("kbo_id", kboId)
    .eq("player_type", playerType)
    .order("game_date", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    { rows: data ?? [], count: data?.length ?? 0 },
    { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" } },
  );
}
