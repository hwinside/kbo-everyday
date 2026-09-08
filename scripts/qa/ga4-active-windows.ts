/** Reviewer/CI only. Real loader and GET route; all outbound HTTP is synthetic. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { loadGa4ActiveWindows } from "../../src/lib/admin/ga4-active-windows";

const now = new Date("2026-09-07T15:05:00Z");
const report = (value: string | null, timeZone = "Asia/Seoul") => ({
  rowCount: value === null ? 0 : 1,
  dimensionHeaders: [], metricHeaders: [{ name: "activeUsers" }], metadata: { timeZone },
  rows: value === null ? [] : [{ metricValues: [{ value }] }],
});

async function loaderChecks() {
  const requests: Record<string, unknown>[] = [];
  const data = await loadGa4ActiveWindows(async body => {
    requests.push(body);
    return report(requests.length === 1 ? "20111" : "30999");
  }, now);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.dateRanges), [
    [{ startDate: "2026-09-02", endDate: "2026-09-08" }],
    [{ startDate: "2026-08-10", endDate: "2026-09-08" }],
  ], "inclusive windows must contain exactly 7/30 days, including today");
  for (const request of requests) {
    assert.deepEqual(request.metrics, [{ name: "activeUsers" }]);
    assert.equal(request.dimensions, undefined, "never sum daily uniques or use a segmented report");
    assert.equal(request.keepEmptyRows, true);
  }
  assert.deepEqual(data.windows, {
    wau: { days: 7, startDate: "2026-09-02", endDate: "2026-09-08", activeUsers: 20111 },
    mau: { days: 30, startDate: "2026-08-10", endDate: "2026-09-08", activeUsers: 30999 },
  });
  assert.equal(data.source, "ga4"); assert.equal(data.includesToday, true);
  const leap = await loadGa4ActiveWindows(async () => report("0"), new Date("2024-03-01T00:05:00Z"));
  assert.equal(leap.windows.mau.startDate, "2024-02-01", "30-day MAU crosses leap February correctly");
  assert.equal(leap.windows.wau.activeUsers, 0, "explicit zero survives");
  const missing = await loadGa4ActiveWindows(async () => report(null), now);
  assert.equal(missing.windows.wau.activeUsers, null); assert.equal(missing.windows.mau.activeUsers, null);
  await assert.rejects(loadGa4ActiveWindows(async () => { throw new Error("GA unavailable"); }), /unavailable/);
  await assert.rejects(loadGa4ActiveWindows(async () => ({ ...report("7"), metricHeaders: [{ name: "active28DayUsers" }] })), /metric/);
  await assert.rejects(loadGa4ActiveWindows(async () => ({ ...report("7"), dimensionHeaders: [{ name: "date" }] })), /undimensioned/);
  await assert.rejects(loadGa4ActiveWindows(async () => ({ ...report("7"), rowCount: 2 })), /row count/);
  await assert.rejects(loadGa4ActiveWindows(async () => report("-1")), /invalid/);
  await assert.rejects(loadGa4ActiveWindows(async () => ({ ...report("7"), metadata: {} })), /timezone/);
  let calls = 0;
  await assert.rejects(loadGa4ActiveWindows(async () => report("7", ++calls === 1 ? "Asia/Seoul" : "UTC")), /timezone changed/);
  await assert.rejects(loadGa4ActiveWindows(async () => ({ ...report("7"), metadata: { timeZone: "Asia/Seoul", samplingMetadatas: [{}] } })), /sampled/);
  const thresholded = await loadGa4ActiveWindows(async () => ({ ...report("7"), metadata: { timeZone: "Asia/Seoul", subjectToThresholding: true } }));
  assert.equal(thresholded.subjectToThresholding, true);
  console.log("PASS GA window loader: 7/30 inclusive range uniques, timezone/leap boundary, explicit zero/missing/error distinction");
}

async function routeChecks() {
  const names = ["ADMIN_PIN", "ADMIN_PIN_HASH", "GOOGLE_SERVICE_ACCOUNT_KEY", "GOOGLE_SERVICE_ACCOUNT_KEY_B64", "GA4_PROPERTY_ID", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
  const before = names.map(name => [name, process.env[name]] as const);
  const originalFetch = globalThis.fetch;
  // An ephemeral signing key exists only in memory for the local OAuth fixture.
  // No stored credential, real account, or real network connection is used.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const fixturePin = "fixture-ga-window-pin";
  process.env.ADMIN_PIN = fixturePin; delete process.env.ADMIN_PIN_HASH;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: "fixture@example.invalid", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  process.env.GA4_PROPERTY_ID = "123456789";
  const requests: Record<string, unknown>[] = [];
  let outbound = 0;
  globalThis.fetch = async (input, init) => {
    outbound += 1;
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "synthetic-ga-access" });
    assert.equal(url, "https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport", "unexpected outbound HTTP is blocked");
    const body = JSON.parse(String(init?.body)); requests.push(body);
    assert.deepEqual(body.metrics, [{ name: "activeUsers" }]);
    assert.equal(body.dimensions, undefined);
    const { startDate, endDate } = body.dateRanges[0];
    assert.match(startDate, /^\d{4}-\d{2}-\d{2}$/); assert.match(endDate, /^\d{4}-\d{2}-\d{2}$/);
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1;
    assert.ok([7, 30].includes(days));
    return Response.json(report(days === 7 ? "20111" : "30999"));
  };
  try {
    // The denied-auth path imports the Supabase admin singleton even without a session.
    // Initialize it without secrets; the fetch fixture still rejects any Supabase call.
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "fixture-anon-key";
    const { GET } = await import("../../src/app/api/admin/analytics/route");
    const denied = await GET(new NextRequest("https://fixture.invalid/api/admin/analytics?type=active-user-windows"));
    assert.equal(denied.status, 401); assert.equal(outbound, 0, "unauthorized requests must not query GA");
    const response = await GET(new NextRequest("https://fixture.invalid/api/admin/analytics?type=active-user-windows", { headers: { "x-admin-pin": fixturePin } }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.windows.wau.activeUsers, 20111); assert.equal(data.windows.mau.activeUsers, 30999);
    assert.equal(requests.length, 2, "route must call both GA window queries");
    assert.equal(response.headers.get("cache-control"), "private, max-age=60");
    assert.equal(response.headers.get("vary"), "Cookie, x-admin-pin");
    console.log("PASS actual authenticated GET route: both GA windows, private cache, unauthorized no-query");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of before) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

loaderChecks().then(routeChecks).then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
