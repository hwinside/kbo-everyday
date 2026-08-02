import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import playersRoster from "@/lib/constants/players-roster.json";

/**
 * 선수별 최애선수 지정 계정 수.
 *
 * 온보딩 선수 선택 목록을 "많이 고른 순" 으로 정렬하기 위한 집계다.
 *
 * 왜 서버 route 인가:
 *   클라이언트에서 profiles 를 읽어 세면 PostgREST 기본 1000행 제한에 걸려
 *   조용히 잘린다(2026-08-03 기준 profiles 25,552행 → 96% 유실된 채 "인기순" 이
 *   된다). 또 남의 프로필 행을 브라우저로 내려보내게 된다.
 *   집계는 DB RPC 에서 끝내고 여기서는 playerId → count 맵만 내보낸다.
 *
 * 응답에 개인 식별 정보는 없다(선수 id 와 숫자뿐).
 */
export const revalidate = 600; // 10분 — 순위가 실시간일 필요는 없다

const ACTIVE_PLAYER_IDS = [
  ...new Set(playersRoster.map((player) => String(player.kboId).trim()).filter(Boolean)),
];

export async function GET() {
  const supabase = getSupabaseAdmin();
  // query-guard: bounded -- 서버 번들의 roster SSOT를 RPC allowlist로 넘기고 SQL도
  // 입력·출력을 1,000행으로 hard-bound한다. profiles의 임의 JSONB ID는 결과 행을 늘릴 수 없다.
  const { data, error } = await supabase.rpc("favorite_player_counts", {
    p_active_player_ids: ACTIVE_PLAYER_IDS,
  });

  if (error) {
    // fail-safe: 순위를 못 구해도 온보딩은 계속돼야 한다.
    // 빈 맵을 주면 클라이언트가 기존 정렬(팀순/가나다순)로 자연스럽게 폴백한다.
    console.error("[player-popularity] rpc failed:", error.message);
    return NextResponse.json(
      { counts: {}, degraded: true },
      { headers: { "Cache-Control": "public, s-maxage=30" } },
    );
  }

  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { player_id: string | null; fan_count: number | string }[]) {
    const id = typeof row.player_id === "string" ? row.player_id.trim() : "";
    if (!id) continue;
    // bigint 는 supabase-js 에서 string 으로 올 수 있다.
    const n = typeof row.fan_count === "number" ? row.fan_count : Number(row.fan_count);
    if (!Number.isFinite(n) || n <= 0) continue;
    counts[id] = n;
  }

  return NextResponse.json(
    { counts, degraded: false },
    { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=600" } },
  );
}
