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

      // WAU: 7-day rolling window
      const wau =
        daily.length >= 7
          ? daily.slice(-7).reduce((s, d) => s + d.activeUsers, 0)
          : daily.reduce((s, d) => s + d.activeUsers, 0);

      // MAU: 30-day total unique (use GA4 metric directly)
      const [mauRes] = await client.runReport({
        property: PROPERTY,
        dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
        metrics: [{ name: "activeUsers" }],
      });
      const mau = Number(mauRes.rows?.[0]?.metricValues?.[0]?.value ?? 0);

      // Today's DAU
      const todayDau = daily.length > 0 ? daily[daily.length - 1].activeUsers : 0;

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
      // Cohort — weekly retention Week 0~4
      const [response] = await client.runReport({
        property: PROPERTY,
        dateRanges: [{ startDate: "35daysAgo", endDate: "today" }],
        dimensions: [
          { name: "newVsReturning" },
          { name: "week" },
        ],
        metrics: [{ name: "activeUsers" }],
        orderBys: [{ dimension: { dimensionName: "week" } }],
      });

      // Build a simple weekly breakdown
      const weeks: Record<string, { new: number; returning: number }> = {};
      for (const row of response.rows ?? []) {
        const week = row.dimensionValues![1].value!;
        const type = row.dimensionValues![0].value!;
        const users = Number(row.metricValues![0].value);
        if (!weeks[week]) weeks[week] = { new: 0, returning: 0 };
        if (type === "new") weeks[week].new = users;
        else weeks[week].returning = users;
      }

      const cohort = Object.entries(weeks)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, data]) => ({
          week,
          newUsers: data.new,
          returningUsers: data.returning,
          retention: data.new > 0
            ? Math.round((data.returning / (data.new + data.returning)) * 100)
            : 0,
        }));

      return NextResponse.json({ cohort });
    }

    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
