/**
 * API Fallback 이벤트 조회
 * 
 * GET /api/monitoring/fallbacks
 * Query params:
 * - days: 조회 기간 (기본 7일)
 * - api: 특정 API만 필터 (선택)
 */

import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";

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

    // 2026-08-20: 1행 = 1발생이 아니다. (api, reason, scope, 1분버킷) 1행 + event_count 합산이므로
    // 발생 횟수는 반드시 sum(event_count)로 읽는다. row count 로 읽으면 폴링 증폭 차단 이후
    // "장애가 줄었다"는 착시가 생긴다(실제로는 로그 행만 줄어든 것).
    // 마이그레이션 이전 행은 event_count 가 null 일 수 있어 1로 취급한다.
    const occurrences = (e: { event_count?: number | null }) => e.event_count ?? 1;

    // API별 그룹화 통계
    const byApi = data.reduce((acc, event) => {
      const api = event.api_name;
      if (!acc[api]) {
        acc[api] = {
          total: 0,
          rows: 0,
          reasons: {} as Record<string, number>,
          latestTimestamp: event.timestamp,
        };
      }
      acc[api].total += occurrences(event);
      acc[api].rows += 1;
      acc[api].reasons[event.reason] = (acc[api].reasons[event.reason] || 0) + occurrences(event);
      return acc;
    }, {} as Record<string, { total: number; rows: number; reasons: Record<string, number>; latestTimestamp: string }>);

    return NextResponse.json({
      events: data,
      summary: {
        total: data.reduce((n, e) => n + occurrences(e), 0),
        rows: data.length,
        byApi,
        period: {
          startDate: startDate.toISOString(),
          endDate: new Date().toISOString(),
          days,
        },
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[API Fallback] Unexpected error:", error);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
