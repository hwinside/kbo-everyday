import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { getKSTToday } from "@/lib/utils/date-kst";
import { fetchGames } from "@/lib/crawler/kbo-api";
import {
  computeCohortRetention,
  computeDailyCohortRetention,
  computeRollingRetention,
  computeActivationFunnel,
  computeGamedayRetention,
  computeVisitDistribution,
} from "@/lib/retention/compute";
import {
  buildDateRange,
  collectGameDates,
  isBackfill,
  resolveTargetDate,
} from "@/lib/retention/gamedates";

const CRON_SECRET = process.env.CRON_SECRET || "";

// 2026-07-21: 60 → 300초 상향 — 집계 데이터 누적(일일 코호트 행 매일 증가)으로 실행시간이 선형 증가,
// 7/19부터 60s 초과 FUNCTION_INVOCATION_TIMEOUT으로 집계 멈춤(7/8 11s → 7/18 51s 실측).
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2026-07-21: `?date=YYYY-MM-DD`로 과거 소급(backfill) 지원 — 7/19~ 타임아웃 결손분 복구 경로.
  // 검증(형식·실존일·미래 금지·60일 이내) 실패 시 400 fail-close. 미지정 시 기존과 동일하게 오늘.
  const todayKst = getKSTToday();
  const resolved = resolveTargetDate(req.nextUrl.searchParams.get("date"), todayKst);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const targetDate = resolved.date;
  // backfill 계약: funnel은 mutable 현재 상태(team_id/favorite_players) 기반이라
  // 과거 exact 복원 불가 → 소급 실행에서는 제외(결측 유지). 상세는 isBackfill JSDoc.
  const backfill = isBackfill(targetDate, todayKst);

  const logId = await startJob("retention");

  try {
    // 1) 경기일 목록 수집 (최근 60일) — 61회 순차 fetch가 전체 실행시간을 크게 잡아먹어
    // 배치 10개씩 병렬로 전환 (2026-07-21, 결과 동일·순서 보장).
    // 실패 날짜는 bounded retry 후에도 남으면 전체 실패(fail-close) —
    // 불완전 gameDates로 gameday 지표를 upsert하면 기존 정상 데이터를 오염시키기 때문.
    const allDates = buildDateRange(targetDate);
    const { gameDates, failedDates } = await collectGameDates(allDates, async (d) => {
      const games = await fetchGames(d.replace(/-/g, ""));
      return games.length > 0;
    });
    if (failedDates.length > 0) {
      throw new Error(
        `game date fetch failed after retries: ${failedDates.join(", ")} — aborting to avoid upserting incomplete gameday metrics`,
      );
    }

    // 2) 3축 집계
    const [cohortRows, dailyCohortRows, rollingRows, funnelRows, gamedayRows, visitDistRows] = await Promise.all([
      computeCohortRetention(supabase, targetDate),
      computeDailyCohortRetention(supabase, targetDate),
      computeRollingRetention(supabase, targetDate),
      backfill ? Promise.resolve([]) : computeActivationFunnel(supabase, targetDate),
      computeGamedayRetention(supabase, targetDate, gameDates),
      computeVisitDistribution(supabase, targetDate),
    ]);

    const allRows = [...cohortRows, ...dailyCohortRows, ...rollingRows, ...funnelRows, ...gamedayRows, ...visitDistRows];

    // 3) Upsert — ON CONFLICT 로 기존 행 덮어쓰기 (중간 실패 시 기존 데이터 보존)
    if (allRows.length > 0) {
      const { error } = await supabase
        .from("retention_metrics")
        .upsert(allRows, {
          onConflict: "date,metric_type,cohort_key,metric_key",
        });

      if (error) throw error;
    }

    const funnelLabel = backfill ? "skipped(backfill)" : String(funnelRows.length);
    const summary = `cohort:${cohortRows.length} dailyCohort:${dailyCohortRows.length} rolling:${rollingRows.length} funnel:${funnelLabel} gameday:${gamedayRows.length} visitDist:${visitDistRows.length} gameDates:${gameDates.length}`;
    await finishJob(logId, "success", summary);

    return NextResponse.json({ ok: true, date: targetDate, summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishJob(logId, "error", undefined, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
