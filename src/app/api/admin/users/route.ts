import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { requireAdmin } from "@/lib/admin/pin";
import { getKSTTodayStart, toKSTDateString } from "@/lib/utils/date-kst";
import { fetchAllByKeyset } from "@/lib/db/paginate";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

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

  // Team distribution + 30-day signups. `profiles` is already >1,000 rows, so one
  // fail-closed keyset snapshot is shared by both aggregates and checked against exact count.
  let profileRows: Array<{ id: string; team_id: number | null; created_at: string }>;
  try {
    profileRows = await fetchAllByKeyset(
      async (cursor, limit) => {
        let query = supabase
          .from("profiles")
          .select("id, team_id, created_at")
          .order("id", { ascending: true })
          .limit(limit);
        if (cursor !== null) query = query.gt("id", cursor);
        return query;
      },
      (row) => row.id,
      { label: "admin user aggregates" },
    );
  } catch (e) {
    return NextResponse.json(
      { error: "fetch_profile_snapshot_failed", detail: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
  if (profileRows.length !== (totalUsers ?? 0)) {
    return NextResponse.json(
      { error: "profile_count_mismatch", expected: totalUsers, selected: profileRows.length },
      { status: 500 },
    );
  }

  const teamMap = new Map<number | null, number>();
  for (const row of profileRows) {
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

  // Daily signup counts (last 30 days) — same verified full snapshot.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const dayMap = new Map<string, number>();
  for (const row of profileRows) {
    if (row.created_at < thirtyDaysAgo) continue;
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
