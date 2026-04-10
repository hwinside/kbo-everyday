/**
 * API Fallback 이벤트 조회
 * 
 * GET /api/monitoring/fallbacks
 * Query params:
 * - days: 조회 기간 (기본 7일)
 * - api: 특정 API만 필터 (선택)
 */

import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "7", 10);
    const apiFilter = searchParams.get("api");

    // N일 전 시작 시각
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // 기본 쿼리
    let query = supabase
      .from("api_fallback_events")
      .select("*")
      .gte("timestamp", startDate.toISOString())
      .order("timestamp", { ascending: false });

    // API 필터
    if (apiFilter) {
      query = query.eq("api_name", apiFilter);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[API Fallback] Query error:", error);
      return NextResponse.json(
        { error: "Failed to fetch fallback events" },
        { status: 500 }
      );
    }

    // API별 그룹화 통계
    const byApi = data.reduce((acc, event) => {
      const api = event.api_name;
      if (!acc[api]) {
        acc[api] = {
          total: 0,
          reasons: {} as Record<string, number>,
          latestTimestamp: event.timestamp,
        };
      }
      acc[api].total += 1;
      acc[api].reasons[event.reason] = (acc[api].reasons[event.reason] || 0) + 1;
      return acc;
    }, {} as Record<string, { total: number; reasons: Record<string, number>; latestTimestamp: string }>);

    return NextResponse.json({
      events: data,
      summary: {
        total: data.length,
        byApi,
        period: {
          startDate: startDate.toISOString(),
          endDate: new Date().toISOString(),
          days,
        },
      },
    });
  } catch (error: any) {
    console.error("[API Fallback] Unexpected error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
