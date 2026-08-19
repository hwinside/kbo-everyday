import { resolvePlayer } from "@/lib/utils/resolve-player";
import { supabaseAdmin } from "@/lib/supabase/admin";

interface GameLogRecord {
  ab: number;
  h: number;
  hr: number;
  rbi: number;
  bb: number;
  so: number;
  ip_outs: number;
  er: number;
  h_allowed: number;
  k: number;
  bb_allowed: number;
}

function didPlay(r: GameLogRecord, playerType: "batter" | "pitcher"): boolean {
  return playerType === "pitcher"
    ? r.ip_outs > 0 || r.h_allowed > 0 || r.bb_allowed > 0 || r.k > 0 || r.er > 0
    : r.ab > 0 || r.h > 0 || r.hr > 0 || r.rbi > 0 || r.bb > 0 || r.so > 0;
}

export async function getPlayerGameLogsRouteResult(rawId: string | null, pos = ""): Promise<{
  body: { rows?: unknown[]; count?: number; error?: string };
  status?: number;
  headers?: HeadersInit;
}> {
  if (!rawId) return { body: { error: "id required" }, status: 400 };

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
    .order("game_date", { ascending: true })
    .order("game_id", { ascending: true });

  if (error) return { body: { error: error.message }, status: 500 };

  const rows = (data ?? []).filter((r) => didPlay(r as GameLogRecord, playerType));
  return {
    body: { rows, count: rows.length },
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  };
}
