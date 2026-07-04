import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin/pin";
import { SignJWT, importPKCS8 } from "jose";

function verifyPin(req: NextRequest): boolean {
  return isAdminRequest(req);
}

/**
 * Get OAuth2 access token using service account JWT
 * (Replaces @google-analytics/data SDK to avoid bundle size issues on Vercel)
 */
async function getAccessToken(): Promise<string> {
  let rawJson: string;

  // Support base64-encoded key (recommended for Vercel env)
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (b64) {
    rawJson = Buffer.from(b64, "base64").toString("utf-8");
  } else if (raw) {
    rawJson = raw;
  } else {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
  }

  const creds = JSON.parse(rawJson);
  const privateKey = (creds.private_key as string).replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(privateKey, "RS256");
  const jwt = await new SignJWT({
    iss: creds.client_email,
    sub: creds.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function ga4Report(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GA4 API ${res.status}: ${err}`);
  }
  return res.json();
}

const PROPERTY_ID = () => process.env.GA4_PROPERTY_ID;

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
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    const accessToken = await getAccessToken();

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
        // true "launch-to-date" even as time passes.
        const response = (await ga4Report(accessToken, {
          dateRanges: [{ startDate: GA4_LAUNCH_DATE, endDate: "today" }],
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

      // 7d / 30d daily — GA4 DateRange는 inclusive라 N일 = (N-1)daysAgo~today
      const startDate = period === "30d" ? "29daysAgo" : "6daysAgo";
      const response = (await ga4Report(accessToken, {
        dateRanges: [{ startDate, endDate: "today" }],
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
