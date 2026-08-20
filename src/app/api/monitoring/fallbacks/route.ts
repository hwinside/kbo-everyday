/**
 * API Fallback 이벤트 조회
 *
 * GET /api/monitoring/fallbacks
 * Query params:
 * - days: 조회 기간 (기본 7일)
 * - api: 특정 API만 필터 (선택)
 *
 * 2026-08-20 (삼순 blocker 3): 종전엔 `.select("*")` 무페이지 조회라 Supabase 기본 1,000행
 * cap 에 조용히 잘렸다. 분당 버킷이라도 경기일엔 하루 1,000행을 넘을 수 있어 합계가 오보가 된다.
 * → 집계를 DB 로 내린다(행을 가져오지 않는다). 발생 횟수는 sum(event_count) 다 — row count 로
 *   읽으면 폴링 증폭 차단 이후 "장애가 줄었다"는 착시가 생긴다(실제로는 로그 행만 줄어든 것).
 */

import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";

interface FallbackSummaryRow {
  api_name: string;
  reason: string;
  occurrences: number;
  rows_stored: number;
  latest_at: string;
  latest_message: string | null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "7", 10);
    const apiFilter = searchParams.get("api");

    // N일 전 시작 시각
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // query-guard: bounded -- summarize_api_fallbacks 는 서버에서 group by 한 집계만 반환한다.
    // 행 수 상한 = (api_name × reason) 카디널리티로, 관제 대상 API 수(수십)에 묶인다.
    // 원본 이벤트 행은 클라로 오지 않으므로 1,000행 cap 에 잘릴 수 없다.
    const { data, error } = await supabase.rpc("summarize_api_fallbacks", {
      p_since: startDate.toISOString(),
      p_until: null,
      p_api_name: apiFilter,
    });

    if (error) {
      console.error("[API Fallback] Query error:", error);
      return NextResponse.json(
        { error: "Failed to fetch fallback events" },
        { status: 500 }
      );
    }

    const rows = (data ?? []) as FallbackSummaryRow[];

    // API별 그룹화 통계
    const byApi = rows.reduce((acc, row) => {
      const api = row.api_name;
      if (!acc[api]) {
        acc[api] = {
          total: 0,
          rows: 0,
          reasons: {} as Record<string, number>,
          latestTimestamp: row.latest_at,
        };
      }
      acc[api].total += Number(row.occurrences);
      acc[api].rows += Number(row.rows_stored);
      acc[api].reasons[row.reason] =
        (acc[api].reasons[row.reason] || 0) + Number(row.occurrences);
      if (row.latest_at > acc[api].latestTimestamp) acc[api].latestTimestamp = row.latest_at;
      return acc;
    }, {} as Record<string, { total: number; rows: number; reasons: Record<string, number>; latestTimestamp: string }>);

    return NextResponse.json({
      // `events`(원본 행)는 더 이상 반환하지 않는다 — 잘린 목록을 전체인 양 내보내는 것이
      // 이 엔드포인트의 원래 결함이었다. 필요하면 별도 페이징 엔드포인트를 만든다.
      breakdown: rows,
      summary: {
        total: rows.reduce((n, r) => n + Number(r.occurrences), 0),
        rows: rows.reduce((n, r) => n + Number(r.rows_stored), 0),
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
