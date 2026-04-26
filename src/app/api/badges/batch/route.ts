import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { checkAndAwardBadges } from "@/lib/supabase/badge-engine";

/**
 * POST /api/badges/batch
 * 전체 유저 대상 배지 일괄 체크.
 * Authorization: Bearer <service_role_key> 또는 admin 토큰 필요.
 */
export async function POST(req: NextRequest) {
  // 간단한 보안: service role key 확인
  const auth = req.headers.get("authorization");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey || auth !== `Bearer ${serviceKey}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 모든 유저 ID 가져오기 (pagination — Supabase default limit 1000)
  const allUsers: { id: string }[] = [];
  let from = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error: fetchError } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .range(from, from + PAGE_SIZE - 1);
    if (fetchError || !data) {
      return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
    }
    allUsers.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  const users = allUsers;

  const results: { userId: string; newBadges: string[] }[] = [];
  let totalNew = 0;

  for (const user of users) {
    try {
      const newBadges = await checkAndAwardBadges(user.id);
      if (newBadges.length > 0) {
        results.push({ userId: user.id, newBadges });
        totalNew += newBadges.length;
      }
    } catch (e) {
      console.error(`Badge check failed for ${user.id}:`, e);
    }
  }

  return NextResponse.json({
    totalUsers: users.length,
    usersWithNewBadges: results.length,
    totalNewBadges: totalNew,
    details: results,
  });
}
