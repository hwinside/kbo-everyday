import { NextRequest, NextResponse } from "next/server";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

function verifyPin(req: NextRequest): boolean {
  return req.headers.get("x-admin-pin") === process.env.ADMIN_PIN;
}

function getClient() {
  return new BetaAnalyticsDataClient({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!),
  });
}

const PROPERTY = "properties/" + process.env.GA4_PROPERTY_ID;

export async function GET(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const type = req.nextUrl.searchParams.get("type") ?? "dau";
  const client = getClient();

  try {
    if (type === "dau") {
      // DAU/WAU/MAU — daily active users for last 30 days + pageviews
      const [response] = await client.runReport({
        property: PROPERTY,
        dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
        dimensions: [{ name: "date" }],
        metrics: [
          { name: "activeUsers" },
          { name: "screenPageViews" },
        ],
        orderBys: [{ dimension: { dimensionName: "date" } }],
      });

      const daily = (response.rows ?? []).map((r) => ({
        date: r.dimensionValues![0].value!,
        activeUsers: Number(r.metricValues![0].value),
        pageViews: Number(r.metricValues![1].value),
      }));

      // Today's DAU
      const todayDau = daily.length > 0 ? daily[daily.length - 1].activeUsers : 0;

      // WAU: 7-day unique active users (single GA4 query, NOT sum of daily)
      const [wauRes] = await client.runReport({
        property: PROPERTY,
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        metrics: [{ name: "activeUsers" }],
      });
      const wau = Number(wauRes.rows?.[0]?.metricValues?.[0]?.value ?? 0);

      // MAU: 30-day unique active users (single GA4 query)
      const [mauRes] = await client.runReport({
        property: PROPERTY,
        dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
        metrics: [{ name: "activeUsers" }],
      });
      const mau = Number(mauRes.rows?.[0]?.metricValues?.[0]?.value ?? 0);

      return NextResponse.json({ daily, dau: todayDau, wau, mau });
    }

    if (type === "pages") {
      // Popular Pages — top 10 by pageviews last 7 days
      const [response] = await client.runReport({
        property: PROPERTY,
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        dimensions: [{ name: "pagePath" }],
        metrics: [{ name: "screenPageViews" }],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit: 10,
      });

      const pages = (response.rows ?? []).map((r) => ({
        path: r.dimensionValues![0].value!,
        views: Number(r.metricValues![0].value),
      }));

      return NextResponse.json({ pages });
    }

    if (type === "cohort") {
      // Weekly user breakdown — new vs returning
      // Note: This is NOT cohort retention analysis.
      // Label: "주간 신규/복귀 유저" (not "코호트")
      const [response] = await client.runReport({
        property: PROPERTY,
        dateRanges: [{ startDate: "35daysAgo", endDate: "today" }],
        dimensions: [
          { name: "newVsReturning" },
          { name: "isoYearIsoWeek" },
        ],
        metrics: [{ name: "activeUsers" }],
        orderBys: [{ dimension: { dimensionName: "isoYearIsoWeek" } }],
      });

      const weeks: Record<string, { new: number; returning: number }> = {};
      for (const row of response.rows ?? []) {
        const week = row.dimensionValues![0].value!;
        const segment = row.dimensionValues![0].value!;
        const weekKey = row.dimensionValues![1].value!;
        const users = Number(row.metricValues![0].value);
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
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
