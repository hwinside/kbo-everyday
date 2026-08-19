import { NextRequest, NextResponse } from "next/server";
import { resolvePlayer } from "@/lib/utils/resolve-player";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface GameLogRecord {
  ab: number; h: number; hr: number; rbi: number; bb: number; so: number;
  ip_outs: number; er: number; h_allowed: number; k: number; bb_allowed: number;
}

/**
 * 출전 여부 판정 — 출전 안 한 경기(타자 무타석 / 투수 무등판)는 노출·최근10에서 제외.
 * 투수는 0이닝이라도 타자를 상대(피안타·삼진·볼넷·자책)했으면 출전으로 본다(예: 0.1 못 채우고 강판).
 */
function didPlay(r: GameLogRecord, playerType: "batter" | "pitcher"): boolean {
  return playerType === "pitcher"
    ? r.ip_outs > 0 || r.h_allowed > 0 || r.bb_allowed > 0 || r.k > 0 || r.er > 0
    : r.ab > 0 || r.h > 0 || r.hr > 0 || r.rbi > 0 || r.bb > 0 || r.so > 0;
}

/**
 * 선수 경기별 로그 (선수 스탯 보강 V1 — 빌드 2: 경기별 탭).
 * spec: specs/stats/player-stats-v1.md §5-1
 *
 * GET /api/player-game-logs?id=<kboId|raw>&pos=<position>
 *   - id: canonical kboId / 숫자 kboId / 레거시 pN 모두 resolvePlayer로 정규화
 *   - pos: "투수" → player_type='pitcher', 그 외 → 'batter'
 *   - 응답: game_date 오름차순(시즌누적 AVG/ERA 계산 자연스럽게). 호출부에서 표시 정렬.
 *   - 출전 안 한 경기는 제외(타자 무타석 / 투수 무등판) — 표·최근10 카운트 양쪽 반영.
 */
export async function getPlayerGameLogsRouteResult(rawId: string | null, pos = ""): Promise<{
  body: { rows?: unknown[]; count?: number; error?: string };
  status?: number;
  headers?: HeadersInit;
}> {
  if (!rawId) {
    return { body: { error: "id required" }, status: 400 };
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
    // 더블헤더/동일일 2경기 누적 AVG/ERA 순서 안정화: game_date 동률 시 game_id로 2차 정렬
    // (game_id = YYYYMMDD+매치업+말미 index → 동일일 DH 순서 보장)
    .order("game_date", { ascending: true })
    .order("game_id", { ascending: true });

  if (error) {
    return { body: { error: error.message }, status: 500 };
  }

  const rows = (data ?? []).filter((r) => didPlay(r as GameLogRecord, playerType));

  return {
    body: { rows, count: rows.length },
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" },
  };
}

export async function GET(request: NextRequest) {
  const searchParams = new URL(request.url).searchParams;
  const result = await getPlayerGameLogsRouteResult(
    searchParams.get("id"),
    searchParams.get("pos") ?? "",
  );
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
