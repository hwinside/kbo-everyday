import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminRequest } from "@/lib/admin/pin";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function verifyPin(req: NextRequest): boolean {
  return isAdminRequest(req);
}

export async function GET(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Total count
  const { count: totalUsers, error: countError } = await supabase
    .from("profiles")
    .select("*", { count: "exact", head: true });

  if (countError) return supabaseErrorResponse(countError);

  // Today's signups
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { count: todaySignups, error: todayError } = await supabase
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .gte("created_at", todayStart.toISOString());

  if (todayError) return supabaseErrorResponse(todayError);

  // Team distribution
  const { data: teamData, error: teamError } = await supabase
    .from("profiles")
    .select("team_id");

  if (teamError) return supabaseErrorResponse(teamError);

  const teamMap = new Map<string | null, number>();
  for (const row of teamData ?? []) {
    const key = row.team_id;
    teamMap.set(key, (teamMap.get(key) ?? 0) + 1);
  }
  const teamDistribution = Array.from(teamMap.entries()).map(
    ([team_id, count]) => ({ team_id, count }),
  );

  // Recent users (limit 20)
  const { data: recentUsers, error: recentError } = await supabase
    .from("profiles")
    .select("id, nickname, team_id, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  if (recentError) return supabaseErrorResponse(recentError);

  return NextResponse.json({
    totalUsers,
    todaySignups,
    teamDistribution,
    recentUsers,
  });
}
