import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * 특정 날짜의 순위 스냅샷(팀별 누적 경기수)을 반환.
 * 순위표 '오늘 결과 반영됨/반영 전' 칩 판정용 baseline 제공.
 *
 * daily_standings_snapshot은 매일 01:00 KST cron이 그날 날짜로 저장하므로,
 * date=오늘(KST) 스냅샷 = '오늘 경기 이전'까지의 누적 성적 baseline이다.
 * games = wins + losses + draws.
 */
export async function GET(req: NextRequest) {
  const dateParam = req.nextUrl.searchParams.get("date"); // YYYYMMDD
  if (!dateParam || !/^\d{8}$/.test(dateParam)) {
    return NextResponse.json({ error: "date param required (YYYYMMDD)" }, { status: 400 });
  }
  const isoDate = `${dateParam.slice(0, 4)}-${dateParam.slice(4, 6)}-${dateParam.slice(6, 8)}`;

  const { data, error } = await supabaseAdmin
    .from("daily_standings_snapshot")
    .select("team_id, wins, losses, draws")
    .eq("date", isoDate);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const teams = (data ?? []).map((r) => ({
    teamId: Number(r.team_id),
    games: Number(r.wins) + Number(r.losses) + Number(r.draws),
  }));

  return NextResponse.json(
    { date: isoDate, count: teams.length, teams },
    { headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
