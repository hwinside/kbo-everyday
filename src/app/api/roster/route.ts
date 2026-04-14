import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import playersRoster from "@/lib/constants/players-roster.json";

export const revalidate = 300; // 5분 ISR 캐시

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("players_roster")
      .select("kbo_id, name, team, team_id, position, back_no")
      .order("name", { ascending: true });

    if (error || !data || data.length === 0) {
      // Supabase 조회 실패 시 정적 JSON fallback
      return NextResponse.json(
        playersRoster.map((p) => ({
          kboId: p.kboId,
          name: p.name,
          team: p.team,
          teamId: p.teamId,
          position: p.position,
          backNo: p.backNo,
        })),
      );
    }

    return NextResponse.json(
      data.map((p) => ({
        kboId: p.kbo_id,
        name: p.name,
        team: p.team,
        teamId: p.team_id,
        position: p.position,
        backNo: p.back_no,
      })),
    );
  } catch {
    // 에러 시 정적 JSON fallback
    return NextResponse.json(playersRoster);
  }
}
