import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function GET(req: NextRequest) {
  const dateParam = req.nextUrl.searchParams.get("date");

  let isoDate: string;
  if (dateParam && /^\d{8}$/.test(dateParam)) {
    isoDate = `${dateParam.slice(0, 4)}-${dateParam.slice(4, 6)}-${dateParam.slice(6, 8)}`;
  } else {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    isoDate = kst.toISOString().slice(0, 10);
  }

  // 1차: 요청 날짜로 조회
  let effectiveDate = isoDate;
  let { data, error } = await supabaseAdmin
    .from("daily_analysis")
    .select("type, delta_json, generated_copy, prompt_version, created_at")
    .eq("date", isoDate);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 2차 fallback: 요청된 날짜에 분석이 없으면 같은 시즌의 가장 최근 생성분 반환
  // (자정~05:00 cron 전 간스, 경기 없는 날 등에서 빈 화면 방지)
  // 시즌 경계 필터: 요청 년도에 해당하는 데이터만 (다음 시즌 전에 작년 분석이 떠오는 것 방지)
  if (!data || data.length === 0) {
    const year = isoDate.slice(0, 4);
    const { data: latest } = await supabaseAdmin
      .from("daily_analysis")
      .select("type, delta_json, generated_copy, prompt_version, created_at, date")
      .lt("date", isoDate)
      .gte("date", `${year}-01-01`)
      .order("date", { ascending: false })
      .limit(20);
    if (latest && latest.length > 0) {
      effectiveDate = latest[0].date;
      // 동일 date 하나만 반환 (standings/batter_titles/pitcher_titles 같은 날짜 묶음)
      data = latest.filter(r => r.date === effectiveDate);
    }
  }

  const result: Record<string, { copy: string | null; delta: unknown; prompt_version: number; created_at: string; lastUpdated?: string }> = {};
  for (const row of data ?? []) {
    const delta = row.delta_json as Record<string, unknown> | null;
    result[row.type] = {
      copy: row.generated_copy,
      delta: row.delta_json,
      prompt_version: row.prompt_version,
      created_at: row.created_at,
      ...(delta?.lastUpdated ? { lastUpdated: delta.lastUpdated as string } : {}),
    };
  }

  return NextResponse.json(
    { date: effectiveDate, requestedDate: isoDate, analysis: result },
    {
      headers: {
        // 매 요청 실시간 — 재생성 직후 구버전 캐시 히트 방지
        "Cache-Control": "no-store, must-revalidate",
      },
    },
  );
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
