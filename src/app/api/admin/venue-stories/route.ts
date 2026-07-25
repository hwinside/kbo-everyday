import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

// 직관 스토리 업로드 집계(어드민). status별 count 를 count(exact, head) 로
// 각각 세어 목록 limit(200)과 무관하게 정확한 총수를 준다.
async function statusCount(status?: string): Promise<number> {
  let query = supabase
    .from("venue_stories")
    .select("id", { count: "exact", head: true });
  if (status) query = query.eq("status", status);
  const { count } = await query;
  return count ?? 0;
}

// KST 오늘 00:00의 UTC ISO. created_at(timestamptz) 비교용.
function kstTodayStartUtcIso(): string {
  const nowUtcMs = Date.now();
  const kstMs = nowUtcMs + 9 * 60 * 60 * 1000;
  const kst = new Date(kstMs);
  const kstMidnightMs = Date.UTC(
    kst.getUTCFullYear(),
    kst.getUTCMonth(),
    kst.getUTCDate(),
  );
  // KST 자정 → UTC 로 되돌릴 때 9시간 뺄다.
  return new Date(kstMidnightMs - 9 * 60 * 60 * 1000).toISOString();
}

// GET: 최근 직관 스토리 목록 + 업로드 집계(어드민 모더레이션)
export async function GET(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 업로드 요약 집계(목록과 병렬). 총/상태별/오늘(KST) 개수.
  const todayStartIso = kstTodayStartUtcIso();
  const [total, active, pending, removed, todayRes] = await Promise.all([
    statusCount(),
    statusCount("active"),
    statusCount("pending"),
    statusCount("removed"),
    supabase
      .from("venue_stories")
      .select("id", { count: "exact", head: true })
      .gte("created_at", todayStartIso),
  ]);
  const counts = {
    total,
    active,
    pending,
    removed,
    today: todayRes.count ?? 0,
  };

  const { data: rows, error } = await supabase
    .from("venue_stories")
    .select(
      "id, game_id, user_id, media_type, media_url, thumb_url, caption, status, report_count, stadium_name, created_at",
    )
    .in("status", ["active", "pending"])
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  const list = rows ?? [];
  const userIds = [...new Set(list.map((r) => r.user_id as string))];
  const nickMap = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, nickname")
      .in("id", userIds);
    for (const p of profiles ?? []) nickMap.set(p.id as string, (p.nickname as string) ?? "");
  }

  const stories = list.map((r) => ({
    id: r.id,
    gameId: r.game_id,
    mediaType: r.media_type,
    mediaUrl: r.media_url,
    thumbUrl: r.thumb_url,
    caption: r.caption,
    status: r.status,
    reportCount: r.report_count,
    stadiumName: r.stadium_name,
    createdAt: r.created_at,
    nickname: nickMap.get(r.user_id as string) ?? "",
  }));
  return NextResponse.json({ stories, counts });
}

// POST: 어드민 즉시 내림(status=removed → 정리 cron 이 storage 정리)
export async function POST(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }
  const storyId = Number(body.storyId);
  if (!Number.isInteger(storyId)) {
    return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
  }
  const { error } = await supabase
    .from("venue_stories")
    .update({ status: "removed" })
    .eq("id", storyId);
  if (error) {
    return NextResponse.json({ error: "처리 실패" }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
