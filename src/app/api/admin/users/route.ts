import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { getKSTTodayStart, toKSTDateString } from "@/lib/utils/date-kst";

async function verifyPin(req: NextRequest): Promise<boolean> {
  return isAdminAuthedRequest(req);
}

export async function GET(req: NextRequest) {
  if (!(await verifyPin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Total count
  const { count: totalUsers, error: countError } = await supabase
    .from("profiles")
    .select("*", { count: "exact", head: true });

  if (countError) return supabaseErrorResponse(countError);

  // Today's signups (KST)
  const { count: todaySignups, error: todayError } = await supabase
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .gte("created_at", getKSTTodayStart());

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

  // Daily signup counts (last 30 days) — paginated fetch to bypass 1000-row default
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const allSignupRows: { created_at: string }[] = [];
  const batchSize = 1000;
  for (let from = 0; ; from += batchSize) {
    const { data, error } = await supabase
      .from("profiles")
      .select("created_at")
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: true })
      .range(from, from + batchSize - 1);
    if (error || !data || data.length === 0) break;
    allSignupRows.push(...data);
    if (data.length < batchSize) break;
  }

  const dayMap = new Map<string, number>();
  for (const row of allSignupRows) {
    const d = toKSTDateString(row.created_at);
    dayMap.set(d, (dayMap.get(d) ?? 0) + 1);
  }
  const dailySignups = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  return NextResponse.json({
    totalUsers,
    todaySignups,
    teamDistribution,
    recentUsers,
    dailySignups,
  });
}
