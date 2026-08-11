import { NextRequest, NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

// 자체 집계 활성 사용자 (앱+웹 통합) — GA4가 아닌 우리 텔레메트리 기준.
// admin_traffic_daily_visitors rollup에서 KST 오늘/7일/30일 window의
// DISTINCT visitor_id를 센다 (전 플랫폼 union). 상세 근거는 migration
// 20260811230000_admin_active_visitors.sql 참조.
export async function GET(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("admin_active_visitors");
  if (error) return supabaseErrorResponse(error as PostgrestError);

  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as {
    dau?: number;
    wau?: number;
    mau?: number;
  };

  // 브라우저가 60초 재사용 — 관리자 대시보드라 신선도 요구 낮음. 인증 입력에
  // Vary를 걸어 로그아웃 탭이 캐시를 읽지 못하게 한다 (traffic route와 동일).
  return NextResponse.json(
    {
      dau: Number(row.dau ?? 0),
      wau: Number(row.wau ?? 0),
      mau: Number(row.mau ?? 0),
    },
    {
      headers: {
        "Cache-Control": "private, max-age=60",
        Vary: "Cookie, x-admin-pin",
      },
    },
  );
}
