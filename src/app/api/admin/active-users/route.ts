import { NextRequest, NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

// 자체 집계 활성 사용자 (앱+웹 통합) — GA4가 아닌 우리 텔레메트리 기준.
// - ?period 없음: KPI (당일/7일/30일/누적 DISTINCT visitor_id)
// - ?period=today|7d|30d|cumulative: 추이 시리즈 (당일=시간대별, 7d/30d=일별,
//   누적=런칭 이후 running — 재방문 중복 제거)
// 상세 근거는 migration 20260811230000_admin_active_visitors.sql 참조.

// 브라우저가 60초 재사용 — 관리자 대시보드라 신선도 요구 낮음. 인증 입력에
// Vary를 걸어 로그아웃 탭이 캐시를 읽지 못하게 한다 (traffic route와 동일).
const CACHE_HEADERS = {
  "Cache-Control": "private, max-age=60",
  Vary: "Cookie, x-admin-pin",
};

const TREND_PERIODS = new Set(["today", "7d", "30d", "cumulative"]);

export async function GET(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const period = req.nextUrl.searchParams.get("period");

  if (period) {
    if (!TREND_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    // query-guard: bounded -- admin_traffic_trend는 집계 결과만 반환: today=시간대 최대
    // 24행, 7d/30d=최대 30행, cumulative=수집일수(하루 1행, 연 최대 366행) 상한.
    const { data, error } = await supabase.rpc("admin_traffic_trend", {
      p_period: period,
    });
    if (error) return supabaseErrorResponse(error as PostgrestError);

    const rows = (data ?? []) as { label: string; users: number; pv: number }[];
    const series = rows.map((r) => ({
      // today의 label은 KST 'HH24' — 기존 GA4 차트와 같은 "N시" 표기로 변환.
      label: period === "today" ? `${Number(r.label)}시` : r.label,
      users: Number(r.users),
      pv: Number(r.pv),
    }));
    return NextResponse.json(
      { period, series, cumulative: period === "cumulative" },
      { headers: CACHE_HEADERS },
    );
  }

  // query-guard: bounded -- admin_active_visitors는 KPI 집계 단일 행(dau/wau/mau/total)만 반환.
  const { data, error } = await supabase.rpc("admin_active_visitors");
  if (error) return supabaseErrorResponse(error as PostgrestError);

  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as {
    dau?: number;
    wau?: number;
    mau?: number;
    total?: number;
  };

  return NextResponse.json(
    {
      dau: Number(row.dau ?? 0),
      wau: Number(row.wau ?? 0),
      mau: Number(row.mau ?? 0),
      total: Number(row.total ?? 0),
    },
    { headers: CACHE_HEADERS },
  );
}
