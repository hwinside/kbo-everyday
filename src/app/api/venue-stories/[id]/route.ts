import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

// DELETE: 본인 직관 스토리 삭제 (storage 오브젝트 + 행 제거)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { id } = await params;
  const storyId = Number(id);
  if (!Number.isInteger(storyId)) {
    return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
  }

  const { data: row, error: fetchErr } = await supabase
    .from("venue_stories")
    .select("id, user_id, media_bucket, media_path, thumb_bucket, thumb_path")
    .eq("id", storyId)
    .maybeSingle();

  if (fetchErr) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "없는 스토리" }, { status: 404 });
  }
  if (row.user_id !== verified.user.id) {
    return NextResponse.json({ error: "본인 것만 삭제할 수 있어요" }, { status: 403 });
  }

  // storage 정리 (실패해도 행은 지운다 — 만료 cron 이 잔여 오브젝트 재정리)
  const byBucket = new Map<string, string[]>();
  const push = (bucket?: string | null, path?: string | null) => {
    if (!bucket || !path) return;
    const arr = byBucket.get(bucket) ?? [];
    arr.push(path);
    byBucket.set(bucket, arr);
  };
  push(row.media_bucket as string, row.media_path as string);
  push(row.thumb_bucket as string | null, row.thumb_path as string | null);
  for (const [bucket, paths] of byBucket) {
    await supabase.storage.from(bucket).remove(paths);
  }

  const { error: delErr } = await supabase
    .from("venue_stories")
    .delete()
    .eq("id", storyId);
  if (delErr) {
    return NextResponse.json({ error: "삭제 실패" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
