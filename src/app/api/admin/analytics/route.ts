import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/pin";
import { ga4Report, getGa4AccessToken } from "@/lib/admin/ga4";



// GA4 "20260405" → "04/05"
function fmtGa4Date(d: string): string {
  return d.length === 8 ? `${d.slice(4, 6)}/${d.slice(6)}` : d;
}

type Ga4Rows = {
  rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
};

// 누적(런칭 이후) 시작일 — 롤링 윈도우가 아닌 고정 시작일이라야 초기 런칭
// 구간이 시간이 지나도 빠지지 않는다. env로 실제 GA4 데이터 시작일 override 가능.
const GA4_LAUNCH_DATE = process.env.GA4_LAUNCH_DATE ?? "2026-01-01";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const type = req.nextUrl.searchParams.get("type") ?? "dau";

  if ((!process.env.GOOGLE_SERVICE_ACCOUNT_KEY && !process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64) || !process.env.GA4_PROPERTY_ID) {
    return NextResponse.json(
      {
        error: "GA4 not configured",
        details: {
          hasKey: !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64),
          hasPropertyId: !!process.env.GA4_PROPERTY_ID,
        },
      },
      { status: 500 },
    );
  }

  try {
    const accessToken = await getGa4AccessToken();

    if (type === "dau") {
      // Daily active users + pageviews for last 30 days
      const response = await ga4Report(accessToken, {
        dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
        dimensions: [{ name: "date" }],
        metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }],
        orderBys: [{ dimension: { dimensionName: "date" } }],
      });

      const rows = (response as { rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }).rows ?? [];
      const daily = rows.map((r) => ({
        date: r.dimensionValues[0].value,
        activeUsers: Number(r.metricValues[0].value),
        pageViews: Number(r.metricValues[1].value),
      }));

      const todayDau = daily.length > 0 ? daily[daily.length - 1].activeUsers : 0;

      // WAU: 7-day unique active users
      const wauRes = await ga4Report(accessToken, {
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        metrics: [{ name: "activeUsers" }],
      });
      const wauRows = (wauRes as { rows?: { metricValues: { value: string }[] }[] }).rows ?? [];
      const wau = Number(wauRows[0]?.metricValues?.[0]?.value ?? 0);

      // MAU: 30-day unique active users
      const mauRes = await ga4Report(accessToken, {
        dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
        metrics: [{ name: "activeUsers" }],
      });
      const mauRows = (mauRes as { rows?: { metricValues: { value: string }[] }[] }).rows ?? [];
      const mau = Number(mauRows[0]?.metricValues?.[0]?.value ?? 0);

      return NextResponse.json({ daily, dau: todayDau, wau, mau });
    }

    if (type === "trend") {
      // DAU/PV trend series with selectable period.
      // - today: hourly buckets (시간대별)
      // - 7d / 30d: daily buckets
      // - cumulative: launch-to-date running totals (DAU = cumulative unique
      //   visitors via newUsers running sum, so revisits aren't double-counted)
      const period = req.nextUrl.searchParams.get("period") ?? "7d";

      if (period === "today") {
        const response = (await ga4Report(accessToken, {
          dateRanges: [{ startDate: "today", endDate: "today" }],
          dimensions: [{ name: "dateHour" }], // YYYYMMDDHH in property timezone (KST)
          metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }],
          orderBys: [{ dimension: { dimensionName: "dateHour" } }],
        })) as Ga4Rows;
        const series = (response.rows ?? []).map((r) => ({
          label: `${Number(r.dimensionValues[0].value.slice(8, 10))}시`,
          users: Number(r.metricValues[0].value),
          pv: Number(r.metricValues[1].value),
        }));
        return NextResponse.json({ period, series, cumulative: false });
      }

      if (period === "cumulative") {
        // Fixed launch date (not a rolling window) so the running sum stays
        // true "launch-to-date" even as time passes. endDate=yesterday so the
        // partial current day doesn't blunt the curve.
        const response = (await ga4Report(accessToken, {
          dateRanges: [{ startDate: GA4_LAUNCH_DATE, endDate: "yesterday" }],
          dimensions: [{ name: "date" }],
          metrics: [{ name: "newUsers" }, { name: "screenPageViews" }],
          orderBys: [{ dimension: { dimensionName: "date" } }],
        })) as Ga4Rows;
        let cumUsers = 0;
        let cumPv = 0;
        const series = (response.rows ?? []).map((r) => {
          cumUsers += Number(r.metricValues[0].value);
          cumPv += Number(r.metricValues[1].value);
          return { label: fmtGa4Date(r.dimensionValues[0].value), users: cumUsers, pv: cumPv };
        });
        return NextResponse.json({ period, series, cumulative: true });
      }

      // 7d / 30d daily — 조회 당일(미완성)은 제외하고 완료된 N일만.
      // endDate=yesterday, GA4 inclusive라 N일 = NdaysAgo~yesterday(1daysAgo).
      const startDate = period === "30d" ? "30daysAgo" : "7daysAgo";
      const response = (await ga4Report(accessToken, {
        dateRanges: [{ startDate, endDate: "yesterday" }],
        dimensions: [{ name: "date" }],
        metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }],
        orderBys: [{ dimension: { dimensionName: "date" } }],
      })) as Ga4Rows;
      const series = (response.rows ?? []).map((r) => ({
        label: fmtGa4Date(r.dimensionValues[0].value),
        users: Number(r.metricValues[0].value),
        pv: Number(r.metricValues[1].value),
      }));
      return NextResponse.json({ period, series, cumulative: false });
    }

    if (type === "pages") {
      const response = await ga4Report(accessToken, {
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        dimensions: [{ name: "pagePath" }],
        metrics: [{ name: "screenPageViews" }],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit: 10,
      });

      const rows = (response as { rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }).rows ?? [];
      const pages = rows.map((r) => ({
        path: r.dimensionValues[0].value,
        views: Number(r.metricValues[0].value),
      }));

      return NextResponse.json({ pages });
    }

    if (type === "cohort") {
      const response = await ga4Report(accessToken, {
        dateRanges: [{ startDate: "35daysAgo", endDate: "today" }],
        dimensions: [{ name: "newVsReturning" }, { name: "isoYearIsoWeek" }],
        metrics: [{ name: "activeUsers" }],
        orderBys: [{ dimension: { dimensionName: "isoYearIsoWeek" } }],
      });

      const rows = (response as { rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }).rows ?? [];
      const weeks: Record<string, { new: number; returning: number }> = {};
      for (const row of rows) {
        const segment = row.dimensionValues[0].value;
        const weekKey = row.dimensionValues[1].value;
        const users = Number(row.metricValues[0].value);
        if (!weeks[weekKey]) weeks[weekKey] = { new: 0, returning: 0 };
        if (segment === "new") weeks[weekKey].new = users;
        else weeks[weekKey].returning = users;
      }

      const weeklyUsers = Object.entries(weeks)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, data]) => ({
          week,
          newUsers: data.new,
          returningUsers: data.returning,
          total: data.new + data.returning,
        }));

      return NextResponse.json({ weeklyUsers });
    }

    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[admin/analytics]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
