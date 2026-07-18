import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const maxDuration = 60;

/**
 * 직관 스토리 정리 cron — 만료(expires_at <= now) 또는 removed 상태 스토리의
 * storage 오브젝트 + 행을 삭제한다. 서버비 절약(경기 종료 후 유지 안 함).
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const nowIso = new Date().toISOString();

  // 만료됐거나 removed 인 행 (최대 500건/실행)
  const { data: rows, error } = await supabase
    .from("venue_stories")
    .select("id, media_bucket, media_path, thumb_bucket, thumb_path")
    .or(`expires_at.lte.${nowIso},status.eq.removed`)
    .limit(500);

  if (error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ removed: 0 });
  }

  // storage 오브젝트 버킷별 일괄 삭제
  const byBucket = new Map<string, string[]>();
  const push = (bucket?: string | null, path?: string | null) => {
    if (!bucket || !path) return;
    const arr = byBucket.get(bucket) ?? [];
    arr.push(path);
    byBucket.set(bucket, arr);
  };
  for (const r of rows) {
    push(r.media_bucket as string, r.media_path as string);
    push(r.thumb_bucket as string | null, r.thumb_path as string | null);
  }
  for (const [bucket, paths] of byBucket) {
    // remove 는 1000개 상한 — 여기선 최대 500행 x 2 = 1000 이내
    await supabase.storage.from(bucket).remove(paths);
  }

  const ids = rows.map((r) => r.id as number);
  const { error: delErr } = await supabase
    .from("venue_stories")
    .delete()
    .in("id", ids);
  if (delErr) {
    return NextResponse.json({ error: "삭제 실패" }, { status: 500 });
  }

  return NextResponse.json({ removed: ids.length });
}
