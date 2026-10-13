/** Reviewer/CI: actual daily loader + actual overview/users render. HTTP is
 * synthetic; no live credentials/accounts/DB writes. Mutations: activeUsers ->
 * active7DayUsers, remove paging, zero-fill missing dates, UI source fallback. */
import assert from "node:assert/strict";
// @ts-expect-error -- test-only dependency without declarations.
import { JSDOM } from "jsdom";
import { loadGa4Dau } from "../../src/lib/admin/ga4-dau";

const now = new Date("2026-09-07T15:05:00Z"); // Sep 8 in GA's reported timezone.
const report = (values: [string, number][], total = values.length) => ({
  rowCount: total, dimensionHeaders: [{ name: "date" }], metricHeaders: [{ name: "activeUsers" }],
  metadata: { timeZone: "Asia/Seoul" },
  rows: values.map(([date, value]) => ({ dimensionValues: [{ value: date }], metricValues: [{ value: String(value) }] })),
});
async function loaderChecks() {
  const requests: Record<string, unknown>[] = [];
  const daily = await loadGa4Dau("7d", async body => {
    requests.push(body);
    if (!body.dimensions) return { ...report([["20260902", 0]]), dimensionHeaders: [] };
    return report([["20260901", 100], ["20260903", 80], ["20260907", 90]]);
  }, now);
  assert.deepEqual(requests[0].dateRanges, [{ startDate: "7daysAgo", endDate: "yesterday" }]);
  assert.deepEqual(requests[0].metrics, [{ name: "activeUsers" }]);
  assert.equal(requests[0].keepEmptyRows, true);
  assert.equal(daily.today, "2026-09-08"); assert.equal(daily.startDate, "2026-09-01");
  assert.equal(daily.daily.length, 7); assert.equal(daily.daily[1].activeUsers, 0);
  assert.equal(daily.daily[0].activeUsers, 100, "do not accumulate daily unique users");
  assert.equal(daily.daily.at(-1)?.date, "2026-09-07", "exclude partial today from history");
  const pending = await loadGa4Dau("today", async () => report([]), now);
  assert.equal(pending.dau, null, "missing today is not yesterday or fabricated zero");
  const zero = await loadGa4Dau("today", async () => report([["20260908", 0]]), now);
  assert.equal(zero.dau, 0, "GA's explicit zero is preserved");
  const gaps = await loadGa4Dau("7d", async body => body.dimensions
    ? report([["20260901", 9], ["20260907", 10]])
    : { ...report([]), dimensionHeaders: [] }, now);
  assert.equal(gaps.daily[1].activeUsers, null, "absent dimension/aggregate rows stay unknown");
  assert.equal(gaps.missingDates.length, 5);

  const historical: [string, number][] = Array.from({ length: 1001 }, (_, i) => {
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10).replaceAll("-", "");
    return [date, i];
  });
  const offsets: number[] = [];
  const all = await loadGa4Dau("all", async body => {
    const offset = Number(body.offset); offsets.push(offset);
    return report(historical.slice(offset, offset + 1000), historical.length);
  }, new Date("2026-10-01T02:00:00Z"));
  assert.deepEqual(offsets, [0, 1000]);
  assert.equal(all.daily[0].date, "2024-01-01");
  assert.equal(all.daily[1000].activeUsers, 1000, "history beyond first API page survives");
  await assert.rejects(loadGa4Dau("all", async () => report(historical.slice(0, 10), 1001), now), /truncated/);
  await assert.rejects(loadGa4Dau("7d", async () => report([["20260901", 1], ["20260901", 2]]), now), /duplicate/);
  await assert.rejects(loadGa4Dau("7d", async () => ({ ...report([]), metadata: {} }), now), /timezone/);
  await assert.rejects(loadGa4Dau("7d", async () => ({ ...report([]), metricHeaders: [{ name: "active7DayUsers" }] }), now), /metric/);
  await assert.rejects(loadGa4Dau("7d", async () => ({ ...report([]), metadata: { timeZone: "Asia/Seoul", dataLossFromOtherRow: true } }), now), /incomplete/);
  await assert.rejects(loadGa4Dau("7d", async () => { throw new Error("fixture GA unavailable"); }, now), /unavailable/);
  console.log("PASS daily loader: actual metric/date bounds, KST metadata, pagination, explicit zero vs missing, no fallback on failed reports");
}

async function renderChecks() {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ["window", "document", "sessionStorage", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "SVGElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    globals[name] = (dom.window as unknown as Record<string, unknown>)[name];
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const Overview = (await import("../../src/app/admin/page")).default;
  const Users = (await import("../../src/app/admin/users/page")).default;
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let gaFails = false;
  let windowsMode: "ok" | "failed" | "missing" | "zero" = "ok";
  let internalFails = false;
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url);
    if (url.includes("type=active-user-windows")) {
      if (windowsMode === "failed") return new Response(null, { status: 502 });
      const count = (value: number) => windowsMode === "missing" ? null : windowsMode === "zero" ? 0 : value;
      return Response.json({ source: "ga4", metric: "activeUsers", timeZone: "Asia/Seoul", includesToday: true,
        windows: { wau: { activeUsers: count(20111) }, mau: { activeUsers: count(30999) } } });
    }
    if (url.includes("type=daily-active-users")) {
      if (gaFails) return new Response(null, { status: 502 });
      return Response.json({ source: "ga4", metric: "activeUsers", dau: 16787, daily: [{ date: "2026-09-04", activeUsers: 16787 }], timeZone: "Asia/Seoul", missingDates: [] });
    }
    if (url.startsWith("/api/admin/active-users?")) return Response.json({ series: [{ label: "09/04", users: 13520, pv: 42000 }], cumulative: url.includes("cumulative") });
    if (url === "/api/admin/active-users") return internalFails ? new Response(null, { status: 502 }) : Response.json({ dau: 13520, wau: 22000, mau: 33000, total: 44000 });
    if (url === "/api/admin/users") return Response.json({ totalUsers: 10, todaySignups: 1, recentUsers: [], dailySignups: [{ date: "2026-09-04", count: 1 }], teamDistribution: [] });
    if (url.includes("/api/admin/content")) return Response.json({ dailyPosts: [] });
    if (url.includes("type=pages")) return Response.json({ pages: [] });
    if (url.includes("type=cohort")) return Response.json({ weeklyUsers: [] });
    if (url.includes("/api/admin/stats") || url.includes("/api/admin/feedback") || url.includes("/api/admin/jobs")) return Response.json({ data: [] });
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  };
  const mount = async (Component: typeof Overview) => {
    const node = document.createElement("div"); document.body.appendChild(node);
    const root = createRoot(node);
    await act(async () => { root.render(React.createElement(Component)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    return { node, close: async () => { await act(async () => root.unmount()); node.remove(); } };
  };
  try {
    let page = await mount(Overview);
    const kpi = (label = "DAU (오늘·GA4)") => [...page.node.querySelectorAll("p")].find(p => p.textContent === label)?.closest(".glass-card");
    assert.ok(kpi()?.textContent?.includes("16,787"));
    assert.ok(!kpi()?.textContent?.includes("13,520"));
    assert.ok(calls.includes("/api/admin/analytics?type=daily-active-users&period=today"));
    assert.ok(calls.includes("/api/admin/analytics?type=daily-active-users&period=7d"));
    assert.ok(calls.includes("/api/admin/active-users?period=7d"), "PV retains internal source");
    assert.ok(kpi("WAU (7일·GA4)")?.textContent?.includes("20,111"));
    assert.ok(kpi("MAU (30일·GA4)")?.textContent?.includes("30,999"));
    assert.ok(kpi("누적 방문자 (앱+웹)")?.textContent?.includes("44,000"), "cumulative ledger remains unchanged");
    assert.ok(calls.includes("/api/admin/analytics?type=active-user-windows"));
    assert.ok(page.node.textContent?.includes("오늘 포함 7일·30일"));
    assert.ok(page.node.textContent?.includes("당일 반영 지연"));
    await page.close();
    windowsMode = "failed"; page = await mount(Overview);
    assert.ok(kpi("WAU (7일·GA4)")?.textContent?.includes("조회 실패"));
    assert.ok(kpi("MAU (30일·GA4)")?.textContent?.includes("조회 실패"));
    assert.ok(!kpi("WAU (7일·GA4)")?.textContent?.includes("22,000"), "GA failure must not fall back to internal WAU");
    assert.ok(!kpi("MAU (30일·GA4)")?.textContent?.includes("33,000"), "GA failure must not fall back to internal MAU");
    assert.ok(kpi()?.textContent?.includes("16,787"), "window outage must not hide available DAU");
    await page.close();
    windowsMode = "missing"; page = await mount(Overview);
    assert.ok(kpi("WAU (7일·GA4)")?.textContent?.includes("집계 대기"));
    assert.ok(kpi("MAU (30일·GA4)")?.textContent?.includes("집계 대기"));
    await page.close();
    windowsMode = "zero"; page = await mount(Overview);
    assert.equal(kpi("WAU (7일·GA4)")?.querySelector(".tabular-nums")?.textContent, "0");
    assert.equal(kpi("MAU (30일·GA4)")?.querySelector(".tabular-nums")?.textContent, "0");
    assert.ok(!kpi("WAU (7일·GA4)")?.textContent?.includes("집계 대기"), "explicit zero is not pending");
    assert.ok(!kpi("MAU (30일·GA4)")?.textContent?.includes("집계 대기"));
    await page.close();
    windowsMode = "ok"; internalFails = true; page = await mount(Overview);
    assert.ok(kpi("WAU (7일·GA4)")?.textContent?.includes("20,111"), "GA windows must not depend on internal ledger availability");
    assert.ok(kpi("MAU (30일·GA4)")?.textContent?.includes("30,999"));
    assert.ok(page.node.textContent?.includes("자체 집계 누적 방문자 조회 실패"));
    await page.close(); internalFails = false;
    gaFails = true; page = await mount(Overview);
    assert.ok(kpi()?.textContent?.includes("조회 실패"));
    assert.ok(!kpi()?.textContent?.includes("13,520"), "failed GA must not use internal DAU");
    await page.close();
    gaFails = false; page = await mount(Users);
    assert.ok(page.node.textContent?.includes("가입자 vs DAU (GA4)"));
    const allButton = [...page.node.querySelectorAll("button")].find(b => b.textContent === "전체(일별)");
    assert.ok(allButton);
    await act(async () => allButton.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    assert.ok(calls.includes("/api/admin/analytics?type=daily-active-users&period=all"));
    await page.close();
    gaFails = true; page = await mount(Users);
    assert.ok(page.node.textContent?.includes("GA4 DAU를 불러오지 못했습니다"));
    await page.close();
    console.log("PASS actual overview/users render: GA DAU/WAU/MAU, range caption, explicit zero/missing/failure, independent internal PV/total, all-history selection");
  } finally { globalThis.fetch = originalFetch; dom.window.close(); }
}
loaderChecks().then(renderChecks).then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
