import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import playersRoster from "@/lib/constants/players-roster.json";

export const revalidate = 300; // 5분 ISR 캐시

interface RosterPlayer {
  kboId: string;
  name: string;
  team: string;
  teamId: number;
  position: string;
  backNo: string;
}

function staticFallback(): RosterPlayer[] {
  return (playersRoster as Array<{
    kboId: string;
    name: string;
    team: string;
    teamId: number;
    position: string;
    backNo: string;
  }>).map((p) => ({
    kboId: String(p.kboId),
    name: p.name,
    team: p.team,
    teamId: p.teamId,
    position: p.position,
    backNo: p.backNo ?? "",
  }));
}

export async function GET() {
  const staticPlayers = staticFallback();

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("players_roster")
      .select("kbo_id, name, team, team_id, position, back_no")
      .order("name", { ascending: true });

    if (error || !data || data.length === 0) {
      return NextResponse.json(staticPlayers);
    }

    // Supabase 데이터 (외국인 신규 등 최신) + static roster (안정 기반 755명) 머지
    // kboId 기준 dedupe: Supabase 우선 (최신 팀/등번호 반영)
    const supabasePlayers: RosterPlayer[] = data.map((p) => ({
      kboId: String(p.kbo_id),
      name: p.name,
      team: p.team,
      teamId: p.team_id,
      position: p.position,
      backNo: p.back_no ?? "",
    }));

    const merged = new Map<string, RosterPlayer>();
    // 1) static 먼저 넣고
    for (const p of staticPlayers) {
      if (p.kboId) merged.set(p.kboId, p);
    }
    // 2) supabase로 덮어씀 (최신 우선)
    for (const p of supabasePlayers) {
      if (p.kboId) merged.set(p.kboId, p);
    }

    const out = Array.from(merged.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "ko"),
    );

    return NextResponse.json(out);
  } catch {
    return NextResponse.json(staticPlayers);
  }
}
