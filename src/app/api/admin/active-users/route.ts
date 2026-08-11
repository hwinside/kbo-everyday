import { NextRequest, NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { ga4Report, getGa4AccessToken } from "@/lib/admin/ga4";

// 자체 집계 활성 사용자 (앱+웹 통합).
// - ?period 없음: KPI (당일/7일/30일은 자체 DISTINCT, 누적은 아래 hybrid)
// - ?period=today|7d|30d: 자체 추이 (시간대별/일별 전역 DISTINCT)
// - ?period=cumulative: 2026-06-24까지 GA4, 06-25부터 자체 영구 원장을
//   이어 붙인다. 화면에는 경계를 노출하지 않고 산식은 코드/PR에만 남긴다.
//
// 중요: GA4 prehistory는 "현재 자체 RPC 실패 시 폴백"이 아니다. 현재 구간의
// RPC가 실패하면 그대로 fail-close하며 GA4로 대체하지 않는다.

const OWN_START_DATE = "2026-06-25";
const GA_PREHISTORY_END = "2026-06-24";
const GA_LAUNCH_DATE = process.env.GA4_LAUNCH_DATE ?? "2026-01-01";

const CACHE_HEADERS = {
  "Cache-Control": "private, max-age=60",
  Vary: "Cookie, x-admin-pin",
};
const TREND_PERIODS = new Set(["today", "7d", "30d", "cumulative"]);

type TrendRow = { label: string; users: number; pv: number };
type GaPrehistory = { series: TrendRow[]; users: number; pv: number };
type Ga4Rows = {
  rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
};

// 6/24 이전은 불변 과거이므로 인스턴스 생명 동안 한 번만 조회한다. 실패 promise는
// 제거해 다음 요청이 복구를 재시도하게 한다 (실패를 캐시하지 않음).
let gaPrehistoryPromise: Promise<GaPrehistory> | null = null;
async function loadGaPrehistory(): Promise<GaPrehistory> {
  if (gaPrehistoryPromise) return gaPrehistoryPromise;
  const pending = (async () => {
    const accessToken = await getGa4AccessToken();
    const report = (await ga4Report(accessToken, {
      dateRanges: [{ startDate: GA_LAUNCH_DATE, endDate: GA_PREHISTORY_END }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "newUsers" }, { name: "screenPageViews" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 1000,
    })) as Ga4Rows;

    let users = 0;
    let pv = 0;
    const series = (report.rows ?? []).map((r) => {
      users += Number(r.metricValues[0]?.value ?? 0);
      pv += Number(r.metricValues[1]?.value ?? 0);
      const date = r.dimensionValues[0]?.value ?? ""; // YYYYMMDD
      return {
        label: date.length === 8 ? `${date.slice(4, 6)}/${date.slice(6)}` : date,
        users,
        pv,
      };
    });
    return { series, users, pv };
  })();
  gaPrehistoryPromise = pending;
  pending.catch(() => {
    if (gaPrehistoryPromise === pending) gaPrehistoryPromise = null;
  });
  return pending;
}

export async function GET(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const period = req.nextUrl.searchParams.get("period");
  try {
    if (period) {
      if (!TREND_PERIODS.has(period)) {
        return NextResponse.json({ error: "Invalid period" }, { status: 400 });
      }
      // query-guard: bounded -- admin_traffic_trend는 집계 결과만 반환: today=시간대 최대
      // 24행, 7d/30d=최대 30행, cumulative=자체 수집일수 하루 1행(영구 원장).
      const { data, error } = await supabase.rpc("admin_traffic_trend", {
        p_period: period,
      });
      if (error) return supabaseErrorResponse(error as PostgrestError);

      const ownRows = (data ?? []) as { label: string; users: number; pv: number }[];
      let series: TrendRow[];
      if (period === "cumulative") {
        if (ownRows.some((r) => r.label < OWN_START_DATE)) {
          throw new Error("internal cumulative series crossed GA4 boundary");
        }
        // 사용자 지시 산식: 6/24 GA 신규사용자 누적 + 6/25 이후 자체 first_seen,
        // 6/24 GA 누적 PV + 이후 자체 일별 PV. 두 ID 공간은 교차 dedupe할 수
        // 없으므로 경계 전후 재방문은 합산되며, 이 한계는 UI가 아닌 코드/PR에 기록.
        const pre = await loadGaPrehistory();
        series = [
          ...pre.series,
          ...ownRows.map((r) => ({
            label: r.label.slice(5).replace("-", "/"), // YYYY-MM-DD → MM/DD
            users: pre.users + Number(r.users),
            pv: pre.pv + Number(r.pv),
          })),
        ];
      } else {
        series = ownRows.map((r) => ({
          label:
            period === "today"
              ? `${Number(r.label)}시`
              : r.label.slice(5).replace("-", "/"),
          users: Number(r.users),
          pv: Number(r.pv),
        }));
      }
      return NextResponse.json(
        { period, series, cumulative: period === "cumulative" },
        { headers: CACHE_HEADERS },
      );
    }

    // query-guard: bounded -- admin_active_visitors는 KPI 단일 행만 반환.
    const { data, error } = await supabase.rpc("admin_active_visitors");
    if (error) return supabaseErrorResponse(error as PostgrestError);

    const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as {
      dau?: number;
      wau?: number;
      mau?: number;
      total?: number;
    };
    // 누적 KPI도 동일 경계 산식. DAU/WAU/MAU는 GA4를 섞지 않는다.
    const pre = await loadGaPrehistory();
    return NextResponse.json(
      {
        dau: Number(row.dau ?? 0),
        wau: Number(row.wau ?? 0),
        mau: Number(row.mau ?? 0),
        total: pre.users + Number(row.total ?? 0),
      },
      { headers: CACHE_HEADERS },
    );
  } catch (error) {
    // GA historical seed 포함 어느 필수 소스든 실패하면 fail-close. 현재 지표를
    // GA4로 바꿔치기하지 않는다.
    const message = error instanceof Error ? error.message : "active users query failed";
    console.error("[admin/active-users]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
