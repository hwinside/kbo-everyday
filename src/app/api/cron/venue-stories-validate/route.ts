import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import {
  validateVenueVideoRow,
  dryRunProbeObject,
} from "@/lib/venue-stories/video-validate-server";
import { VENUE_STORY_STAGING_BUCKET } from "@/lib/venue-stories/types";

const CRON_SECRET = process.env.CRON_SECRET || "";
const BATCH = 10;
// dry-run 은 직관 라이브 예약 prefix 의 안전 charset 경로만 허용(임의 객체 프로브 방지)
const DRYRUN_BUCKETS = new Set(["videos", "photos", VENUE_STORY_STAGING_BUCKET]);
const DRYRUN_PATH_RE = /^venue-stories[A-Za-z0-9._/-]*$/;

export const maxDuration = 60;

/**
 * 직관 라이브 영상 즉시 검증 — 운영/복구 보조 경로(B+①, 삼순 09:44 #1).
 *  - 기본: 즉시 경로(업로드 요청 인라인 검증)가 fault 로 놓친 pending 영상을 배치 처리.
 *    (주 복구는 30분 GitHub Actions 워커 — 이 route 는 수동/운영 트리거용, vercel cron 미등록)
 *  - ?bucket=&path= : storage 객체 ffprobe 판정만 반환(DB 무변경) — Vercel 런타임에서
 *    서버 권위 ffprobe 검증이 실제 동작하는지 실호출로 확인하는 진단 표면.
 *  - CAS(status='pending' 조건 갱신) 기반이라 즉시 경로/워커와 중복 claim 불가.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 진단 dry-run (DB 무변경) ──
  const bucket = req.nextUrl.searchParams.get("bucket");
  const path = req.nextUrl.searchParams.get("path");
  if (bucket || path) {
    if (!bucket || !path || !DRYRUN_BUCKETS.has(bucket) || !DRYRUN_PATH_RE.test(path) || path.length > 512) {
      return NextResponse.json({ error: "잘못된 dry-run 대상" }, { status: 400 });
    }
    const result = await dryRunProbeObject(bucket, path);
    if ("error" in result) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json({ dryRun: true, ...result });
  }

  // ── pending 영상 배치 검증(즉시 경로 fault 복구) ──
  // query-guard: bounded -- 운영 복구 1회당 고정 BATCH 영상만 처리
  const { data: rows, error } = await supabase
    .from("venue_stories")
    .select("id, media_bucket, media_path, attendance_source")
    .eq("media_type", "video")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH);
  if (error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  let promoted = 0;
  let rejected = 0;
  let claimed = 0;
  let faults = 0;
  for (const r of rows ?? []) {
    const res = await validateVenueVideoRow({
      id: r.id as number,
      media_bucket: r.media_bucket as string,
      media_path: r.media_path as string,
    }, {
      promoteStatus: r.attendance_source === "diary_manual" ? "archived" : "active",
    });
    if (res.outcome === "promoted") promoted++;
    else if (res.outcome === "rejected") rejected++;
    else if (res.outcome === "already_claimed") claimed++;
    else faults++;
  }

  const body = { checked: (rows ?? []).length, promoted, rejected, claimed, faults };
  return NextResponse.json(body, { status: faults > 0 ? 500 : 200 });
}
