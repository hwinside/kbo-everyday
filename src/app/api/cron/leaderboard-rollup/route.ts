import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

const CRON_SECRET = process.env.CRON_SECRET || "";

// full recompute 1회 ~316ms 실측 기준 — 여유롭게 60s
export const maxDuration = 60;

/**
 * GET /api/cron/leaderboard-rollup — 5분 주기 (vercel.json crons)
 *
 * 글쓰기 리더보드 스냅샷(leaderboard_writing_rollup) full recompute.
 * - 집계 SSOT: supabase/migrations/20260723_leaderboard_writing_rollup.sql
 *   (leaderboard_writing_rollup_refresh — service_role 전용, idempotent)
 * - v_leaderboard_writing 이 이 스냅샷을 읽으므로 API 3곳(writing/my-rank/ProfileCard)
 *   호출당 전체 재집계가 사라진다 (24h 실측 911초 → cron 5분당 ~0.3초).
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const { data, error } = await supabase.rpc("leaderboard_writing_rollup_refresh");
  if (error) {
    return NextResponse.json(
      { error: "rollup refresh failed", details: error.message },
      { status: 500 },
    );
  }

  // advisory try-lock 획득 실패(= 다른 refresh 진행 중) — 정상 경로, 이번 틱만 skip
  if (data === "skipped_lock_busy") {
    return NextResponse.json({ ok: true, skipped: true, tookMs: Date.now() - started });
  }

  return NextResponse.json({ ok: true, tookMs: Date.now() - started });
}
