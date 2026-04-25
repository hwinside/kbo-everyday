import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { getKSTToday } from "@/lib/utils/date-kst";
import { fetchGames } from "@/lib/crawler/kbo-api";
import {
  computeCohortRetention,
  computeActivationFunnel,
  computeGamedayRetention,
} from "@/lib/retention/compute";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("retention");
  const targetDate = getKSTToday();

  try {
    // 1) 경기일 목록 수집 (최근 60일)
    const gameDates: string[] = [];
    for (let i = 60; i >= 0; i--) {
      const d = new Date(
        new Date(targetDate + "T00:00:00+09:00").getTime() - i * 86400000,
      ).toISOString().slice(0, 10);
      try {
        const games = await fetchGames(d.replace(/-/g, ""));
        if (games.length > 0) gameDates.push(d);
      } catch {
        // skip dates where API fails
      }
    }

    // 2) 3축 집계
    const [cohortRows, funnelRows, gamedayRows] = await Promise.all([
      computeCohortRetention(supabase, targetDate),
      computeActivationFunnel(supabase, targetDate),
      computeGamedayRetention(supabase, targetDate, gameDates),
    ]);

    const allRows = [...cohortRows, ...funnelRows, ...gamedayRows];

    // 3) Upsert — ON CONFLICT 로 기존 행 덮어쓰기 (중간 실패 시 기존 데이터 보존)
    if (allRows.length > 0) {
      const { error } = await supabase
        .from("retention_metrics")
        .upsert(allRows, {
          onConflict: "date,metric_type,cohort_key,metric_key",
        });

      if (error) throw error;
    }

    const summary = `cohort:${cohortRows.length} funnel:${funnelRows.length} gameday:${gamedayRows.length} gameDates:${gameDates.length}`;
    await finishJob(logId, "success", summary);

    return NextResponse.json({ ok: true, date: targetDate, summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishJob(logId, "error", undefined, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
