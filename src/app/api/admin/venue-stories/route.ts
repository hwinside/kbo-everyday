import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

// GET: 최근 직관 스토리 목록(어드민 모더레이션)
export async function GET(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
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
  return NextResponse.json({ stories });
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
    // removed_at 기록 → cleanup 이 removed_at 기준 30일 격리 후 삭제(오신고 복구 여지).
    .update({ status: "removed", removed_at: new Date().toISOString() })
    .eq("id", storyId);
  if (error) {
    return NextResponse.json({ error: "처리 실패" }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
