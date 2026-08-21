import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { JSDOM } from "jsdom";
import { NextRequest } from "next/server";
import { GET } from "../../src/app/api/admin/system-health/route";
import { computeInstantCpuFromStore, cpuUsedPercentFromSnapshots, parsePrometheusText, summarizeSystemMetrics } from "../../src/lib/admin/system-health";

const isDomChild = process.env.ADMIN_SYSTEM_HEALTH_DOM_CHILD === "1";
const domTest = process.env.NODE_ENV === "production" && !isDomChild ? test.skip : test;

let reactHarness: Promise<{
  React: typeof import("react");
  act: typeof import("react").act;
  createRoot: typeof import("react-dom/client").createRoot;
  SystemHealthPanel: typeof import("../../src/app/admin/system/SystemHealthPanel").default;
}> | null = null;

function loadReactHarness() {
  if (reactHarness) return reactHarness;
  reactHarness = Promise.all([
    import("react"),
    import("react-dom/client"),
    import("../../src/app/admin/system/SystemHealthPanel"),
  ]).then(([React, reactDom, panel]) => ({
    React,
    act: React.act,
    createRoot: reactDom.createRoot,
    SystemHealthPanel: panel.default,
  }));
  return reactHarness;
}

test("production prebuild executes DOM regressions with the test React build", {
  skip: process.env.NODE_ENV !== "production" || isDomChild,
}, () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "scripts/qa/admin-system-health-smoke.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        ADMIN_SYSTEM_HEALTH_DOM_CHILD: "1",
      },
    },
  );
  assert.equal(
    result.status,
    0,
    `DOM regression child failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
});

const sample = (overrides = "") => `
node_cpu_seconds_total{cpu="0",mode="idle"} 100.6
node_cpu_seconds_total{cpu="0",mode="user"} 50.4
node_cpu_seconds_total{cpu="1",mode="idle"} 100.6
node_cpu_seconds_total{cpu="1",mode="user"} 50.4
node_load1 0.8
node_memory_MemTotal_bytes 1000
node_memory_MemFree_bytes 200
node_memory_Buffers_bytes 100
node_memory_Cached_bytes 100
node_filesystem_avail_bytes{device="/dev/root",fstype="ext4",mountpoint="/"} 300
node_filesystem_size_bytes{device="/dev/root",fstype="ext4",mountpoint="/"} 1000
pg_up 1
pgbouncer_up 1
pg_stat_database_num_backends 26
pgbouncer_pools_client_active_connections{user="one"} 2
pgbouncer_pools_client_active_connections{user="two"} 3
pgbouncer_pools_client_waiting_connections 0
pg_stat_activity_xact_runtime 0.1
${overrides}
`;

const previousSample = (overrides = "") => `
node_cpu_seconds_total{cpu="0",mode="idle"} 100
node_cpu_seconds_total{cpu="0",mode="user"} 50
node_cpu_seconds_total{cpu="1",mode="idle"} 100
node_cpu_seconds_total{cpu="1",mode="user"} 50
${overrides}
`;

test("parses labels and scientific notation", () => {
  const rows = parsePrometheusText('metric_name{mountpoint="/",device="nvme0"} 8.1e+09\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].labels.mountpoint, "/");
  assert.equal(rows[0].value, 8.1e9);
});

test("summarizes healthy server and DB metrics", () => {
  const result = summarizeSystemMetrics(sample(), previousSample(), 1);
  assert.equal(result.level, "healthy");
  assert.equal(result.cpuUsedPercent, 40);
  assert.equal(result.load1, 0.8);
  assert.equal(result.load1PerCore, 0.4);
  assert.equal(result.cpuSampleSeconds, 1);
  assert.equal(result.memoryUsedPercent, 60);
  assert.equal(result.diskUsedPercent, 70);
  assert.equal(result.postgresConnections, 26);
  assert.equal(result.poolActiveConnections, 5);
});

test("high load average is not mislabeled or escalated as CPU usage", () => {
  const result = summarizeSystemMetrics(
    sample().replace("node_load1 0.8", "node_load1 8"),
    previousSample(),
    1,
  );
  assert.equal(result.cpuUsedPercent, 40);
  assert.equal(result.load1, 8);
  assert.equal(result.load1PerCore, 4);
  assert.equal(result.level, "healthy");
  assert.ok(result.reasons.every((reason) => !reason.startsWith("CPU")));
});

test("instant CPU stays informational instead of impersonating sustained alert health", () => {
  const result = summarizeSystemMetrics(
    sample()
      .replaceAll('mode="idle"} 100.6', 'mode="idle"} 100.1')
      .replaceAll('mode="user"} 50.4', 'mode="user"} 50.9'),
    previousSample(),
    1,
  );
  assert.equal(result.cpuUsedPercent, 90);
  assert.equal(result.level, "healthy");
  assert.ok(result.reasons.every((reason) => !reason.startsWith("CPU")));
});

test("CPU stays unknown without a counter delta instead of falling back to load average", () => {
  const result = summarizeSystemMetrics(sample().replace("node_load1 0.8", "node_load1 8"));
  assert.equal(result.cpuUsedPercent, null);
  assert.equal(result.load1, 8);
  assert.equal(result.level, "healthy");
  assert.ok(result.reasons.every((reason) => !reason.includes("CPU")));
});

test("raises warning at resource thresholds", () => {
  const warningSample = sample()
    .replace("node_memory_MemFree_bytes 200", "node_memory_MemFree_bytes 50")
    .replace("node_memory_Buffers_bytes 100", "node_memory_Buffers_bytes 50");
  const result = summarizeSystemMetrics(warningSample);
  assert.equal(result.level, "warning");
  assert.ok(result.reasons.some((reason) => reason.startsWith("메모리")));
});

test("raises critical for DB connection waits", () => {
  const result = summarizeSystemMetrics(sample("pgbouncer_pools_client_waiting_connections{user=\"blocked\"} 2"));
  assert.equal(result.level, "critical");
  assert.ok(result.reasons.includes("DB 연결 대기 2건"));
});

test("returns unknown for malformed or empty input", () => {
  const result = summarizeSystemMetrics("# no samples\nnot valid");
  assert.equal(result.level, "unknown");
  assert.equal(result.memoryUsedPercent, null);
});

test("returns unknown for HTTP 200 payloads without core metrics", () => {
  const result = summarizeSystemMetrics("unrelated_metric 1\n");
  assert.equal(result.level, "unknown");
  assert.ok(result.reasons.includes("핵심 메트릭 없음"));
});

test("degrades partial core metrics instead of reporting healthy", () => {
  const result = summarizeSystemMetrics("pg_up 1\npgbouncer_up 1\n");
  assert.equal(result.level, "warning");
  assert.ok(result.reasons.some((reason) => reason.startsWith("핵심 메트릭 누락")));
});

test("preserves critical DB waits when all core metrics are missing", () => {
  const result = summarizeSystemMetrics("pgbouncer_pools_client_waiting_connections 2\n");
  assert.equal(result.level, "critical");
  assert.ok(result.reasons.includes("DB 연결 대기 2건"));
  assert.ok(result.reasons.includes("핵심 메트릭 없음"));
});

test("preserves critical long transactions when all core metrics are missing", () => {
  const result = summarizeSystemMetrics("pg_stat_activity_xact_runtime 120\n");
  assert.equal(result.level, "critical");
  assert.ok(result.reasons.includes("장기 트랜잭션 120초"));
  assert.ok(result.reasons.includes("핵심 메트릭 없음"));
});

test("treats any pg_up down sample as critical", () => {
  const result = summarizeSystemMetrics("pg_up 1\npg_up 0\n");
  assert.equal(result.level, "critical");
  assert.equal(result.postgresUp, false);
  assert.ok(result.reasons.includes("PostgreSQL 응답 없음"));
});

test("treats any pgbouncer_up down sample as critical", () => {
  const result = summarizeSystemMetrics("pgbouncer_up 1\npgbouncer_up 0\n");
  assert.equal(result.level, "critical");
  assert.equal(result.poolerUp, false);
  assert.ok(result.reasons.includes("PgBouncer 응답 없음"));
});

const healthyServices = ["db", "rest", "auth", "storage"].map((name) => ({
  name,
  status: "ACTIVE_HEALTHY",
}));

async function routeWith(fetchImpl: typeof fetch) {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    ADMIN_PIN: process.env.ADMIN_PIN,
    ADMIN_PIN_HASH: process.env.ADMIN_PIN_HASH,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_MANAGEMENT_TOKEN: process.env.SUPABASE_MANAGEMENT_TOKEN,
    VERCEL_TOKEN: process.env.VERCEL_TOKEN,
  };
  process.env.ADMIN_PIN = "health-test-pin";
  delete process.env.ADMIN_PIN_HASH;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://health-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.SUPABASE_MANAGEMENT_TOKEN = "test-management-token";
  process.env.VERCEL_TOKEN = "test-vercel-token";
  globalThis.fetch = fetchImpl;
  try {
    return await GET(
      new NextRequest("http://localhost/api/admin/system-health", {
        headers: { "x-admin-pin": "health-test-pin" },
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("route returns one cumulative CPU snapshot for the client refresh delta", async () => {
  let metricCalls = 0;
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) {
      metricCalls += 1;
      return new Response(sample().replace("node_load1 0.8", "node_load1 8"), { status: 200 });
    }
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(metricCalls, 1);
  assert.equal(payload.level, "healthy");
  assert.equal(payload.metrics.cpuUsedPercent, null);
  assert.deepEqual(payload.metrics.cpuCounter, {
    totalSeconds: 302,
    idleSeconds: 201.2,
    seriesFingerprint: "cpu=0|mode=idle;cpu=0|mode=user;cpu=1|mode=idle;cpu=1|mode=user",
  });
  assert.equal(payload.metrics.load1, 8);
  assert.equal(payload.metrics.load1PerCore, 4);
});

test("client CPU delta derives busy percent across exporter scrape intervals", () => {
  const used = cpuUsedPercentFromSnapshots(
    { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: "cpu0" },
    { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: "cpu0" },
  );
  assert.ok(used !== null && Math.abs(used - 40) < 0.001);
  assert.equal(
    cpuUsedPercentFromSnapshots(
      { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: "cpu0" },
      { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: "cpu0" },
    ),
    null,
  );
});

test("computeInstantCpuFromStore rates current against the freshest stored snapshot", () => {
  const fp = "cpu0";
  const now = Date.parse("2026-08-21T10:00:00.000Z");
  const current = { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: fp };
  const result = computeInstantCpuFromStore(
    [
      { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now - 60_000 },
      { totalSeconds: 300, idleSeconds: 200, seriesFingerprint: fp, capturedAtMs: now - 120_000 },
    ],
    current,
    now,
  );
  assert.ok(result);
  assert.ok(Math.abs(result.usedPercent - 40) < 0.001);
  assert.equal(result.windowSeconds, 60);
  assert.equal(result.sampleEndedAtMs, now); // 현재 counter가 전진 → rate 종료 = now
});

// 삼순 2차 blocker 1: 정상 주기의 [최신 C=-31초, 직전 B=-91초] + 현재=C 상황도 값이 나와야 한다.
test("computeInstantCpuFromStore keeps the value when current equals the newest stored tick", () => {
  const fp = "cpu0";
  const now = Date.parse("2026-08-21T10:00:00.000Z");
  const current = { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: fp };
  const result = computeInstantCpuFromStore(
    [
      { ...current, capturedAtMs: now - 31_000 }, // C — 현재와 동일 tick
      { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now - 91_000 }, // B
    ],
    current,
    now,
  );
  assert.ok(result, "동일 최신 tick + 직전 91쓸에서도 측정 중이 되면 안 된다");
  assert.ok(Math.abs(result.usedPercent - 40) < 0.001);
  assert.equal(result.windowSeconds, 60); // C↔B 창
  assert.equal(result.sampleEndedAtMs, now - 31_000); // freshness 기준은 C 시각
});

// 삼순 2차 blocker 2: counter가 2분 이상 멈추면 현재값으로 위장하지 않는다.
test("computeInstantCpuFromStore fails closed when the counter has been frozen", () => {
  const fp = "cpu0";
  const now = Date.parse("2026-08-21T10:00:00.000Z");
  const current = { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: fp };
  const frozen = computeInstantCpuFromStore(
    [
      { ...current, capturedAtMs: now - 130_000 }, // 동일 counter, 2분 이상 정지
      { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now - 190_000 },
    ],
    current,
    now,
  );
  assert.equal(frozen, null);
});

test("computeInstantCpuFromStore fails closed on foreign/stale/reset/empty rows", () => {
  const fp = "cpu0";
  const now = Date.parse("2026-08-21T10:00:00.000Z");
  const current = { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: fp };
  // fingerprint 불일치 → null
  assert.equal(
    computeInstantCpuFromStore([{ totalSeconds: 300, idleSeconds: 200, seriesFingerprint: "other", capturedAtMs: now - 60_000 }], current, now),
    null,
  );
  // 창 상한(150초) 초과 → null (장기 평균을 순간값으로 위장 금지)
  assert.equal(
    computeInstantCpuFromStore([{ totalSeconds: 300, idleSeconds: 200, seriesFingerprint: fp, capturedAtMs: now - 151_000 }], current, now),
    null,
  );
  // counter 리셋(역전) → null
  assert.equal(
    computeInstantCpuFromStore([{ totalSeconds: 400, idleSeconds: 300, seriesFingerprint: fp, capturedAtMs: now - 60_000 }], current, now),
    null,
  );
  // 빈 저장소 → null
  assert.equal(computeInstantCpuFromStore([], current, now), null);
});

test("route fills CPU instantly from the Edge Config baseline (read-only enforced)", async () => {
  const fp = "cpu=0|mode=idle;cpu=0|mode=user;cpu=1|mode=idle;cpu=1|mode=user";
  let storeReads = 0;
  let storeWrites = 0;
  const response = await routeWith(async (input, init) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) {
      return new Response(sample(), { status: 200 });
    }
    if (url.includes("api.vercel.com/v1/edge-config")) {
      const method = (init?.method || "GET").toUpperCase();
      if (method !== "GET") {
        storeWrites += 1;
        return new Response(null, { status: 200 });
      }
      storeReads += 1;
      return Response.json({
        key: "cpuSnapshots",
        value: [{ t: Date.now() - 60_000, fp, total: 300, idle: 200 }],
      });
    }
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(storeReads, 1);
  assert.equal(storeWrites, 0); // 삼순 게이트: health 경로는 읽기 전용 — write 0 강제
  assert.equal(payload.metrics.cpuUsedPercent, 40);
  assert.ok(payload.metrics.cpuSampleSeconds !== null && payload.metrics.cpuSampleSeconds >= 59 && payload.metrics.cpuSampleSeconds <= 62);
});

// 삼순 2차 blocker 1 회귀: 동일 최신 tick(C=-31초) + 직전(B=-91초)에서도 값이 유지되고
// freshness 기준은 rate 종료 시각(C)으로 고정된다.
test("route keeps the value when current equals the newest stored tick (no 측정 중 gap)", async () => {
  const fp = "cpu=0|mode=idle;cpu=0|mode=user;cpu=1|mode=idle;cpu=1|mode=user";
  const cAtMs = Date.now() - 31_000;
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) {
      return new Response(sample(), { status: 200 });
    }
    if (url.includes("api.vercel.com/v1/edge-config")) {
      return Response.json({
        key: "cpuSnapshots",
        value: [
          { t: cAtMs, fp, total: 302, idle: 201.2 }, // 현재 counter와 동일 tick
          { t: cAtMs - 60_000, fp, total: 300, idle: 200 },
        ],
      });
    }
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(payload.metrics.cpuUsedPercent, 40);
  assert.equal(payload.metrics.cpuSampleSeconds, 60);
  assert.equal(Date.parse(payload.metrics.cpuSampleEndedAt), cAtMs);
});

test("route rejects a frozen counter (rate older than 90s) as 측정 중", async () => {
  const fp = "cpu=0|mode=idle;cpu=0|mode=user;cpu=1|mode=idle;cpu=1|mode=user";
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) {
      return new Response(sample(), { status: 200 });
    }
    if (url.includes("api.vercel.com/v1/edge-config")) {
      return Response.json({
        key: "cpuSnapshots",
        value: [
          { t: Date.now() - 130_000, fp, total: 302, idle: 201.2 }, // 현재와 동일 = 2분 이상 정지
          { t: Date.now() - 190_000, fp, total: 300, idle: 200 },
        ],
      });
    }
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(payload.metrics.cpuUsedPercent, null); // 멈춘 counter를 현재값으로 위장 금지
  assert.equal(payload.metrics.cpuSampleEndedAt, null);
});

test("route rejects a window longer than the 150s cap", async () => {
  const fp = "cpu=0|mode=idle;cpu=0|mode=user;cpu=1|mode=idle;cpu=1|mode=user";
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) {
      return new Response(sample(), { status: 200 });
    }
    if (url.includes("api.vercel.com/v1/edge-config")) {
      return Response.json({
        key: "cpuSnapshots",
        value: [{ t: Date.now() - 151_000, fp, total: 300, idle: 200 }],
      });
    }
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(payload.metrics.cpuUsedPercent, null); // 장기 평균을 순간값으로 위장 금지
});

test("route degrades to client-delta path when the snapshot store is unavailable", async () => {
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) {
      return new Response(sample(), { status: 200 });
    }
    if (url.includes("api.vercel.com/v1/edge-config")) {
      return new Response("store down", { status: 500 });
    }
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(payload.metrics.cpuUsedPercent, null); // 저장소 실패 = 즉시값만 비활성 (기존 계약 유지)
  assert.deepEqual(payload.metrics.cpuCounter?.totalSeconds, 302);
});

domTest("UI turns the first cumulative counter into CPU percent on refresh", async () => {
  const { React, act, createRoot, SystemHealthPanel } = await loadReactHarness();
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/admin/system",
  });
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = {
    window: globals.window,
    document: globals.document,
    navigator: globals.navigator,
    HTMLElement: globals.HTMLElement,
    sessionStorage: globals.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
    fetch: globalThis.fetch,
  };
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.navigator = dom.window.navigator;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.sessionStorage = dom.window.sessionStorage;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.sessionStorage.setItem("admin_pin", "health-test-pin");

  const first = summarizeSystemMetrics(sample());
  const second = summarizeSystemMetrics(sample());
  assert.ok(first.cpuCounter && second.cpuCounter);
  second.cpuCounter = {
    totalSeconds: first.cpuCounter.totalSeconds + 240,
    idleSeconds: first.cpuCounter.idleSeconds + 144,
    seriesFingerprint: first.cpuCounter.seriesFingerprint,
  };
  const unchanged = structuredClone(second);
  const reset = structuredClone(second);
  reset.cpuCounter = { totalSeconds: 10, idleSeconds: 6, seriesFingerprint: first.cpuCounter.seriesFingerprint };
  const recovered = structuredClone(reset);
  recovered.cpuCounter = { totalSeconds: 110, idleSeconds: 76, seriesFingerprint: first.cpuCounter.seriesFingerprint };
  const seriesChanged = structuredClone(recovered);
  seriesChanged.cpuCounter = { ...recovered.cpuCounter, seriesFingerprint: `${first.cpuCounter.seriesFingerprint};cpu=2|mode=idle` };
  const seriesRecovered = structuredClone(seriesChanged);
  seriesRecovered.cpuCounter = { totalSeconds: seriesChanged.cpuCounter.totalSeconds + 100, idleSeconds: seriesChanged.cpuCounter.idleSeconds + 80, seriesFingerprint: seriesChanged.cpuCounter.seriesFingerprint };
  const snapshots = [first, second, unchanged, reset, recovered, seriesChanged, seriesRecovered];
  let calls = 0;
  globalThis.fetch = (async () => {
    const index = calls++;
    return Response.json({
      level: "healthy",
      metrics: snapshots[index],
      services: healthyServices.map((service) => ({ ...service, level: "healthy" })),
      sourceErrors: { metrics: null, management: null },
      checkedAt: new Date(Date.parse("2026-08-20T14:00:00.000Z") + index * 60_000).toISOString(),
    });
  }) as typeof fetch;

  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(SystemHealthPanel)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    assert.match(container.textContent || "", /CPU 사용률순간값측정 중첫 샘플 수집 중/);
    const refresh = container.querySelector('button[aria-label="서버 상태 새로고침"]') as HTMLButtonElement | null;
    assert.ok(refresh);
    await act(async () => {
      refresh.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.match(container.textContent || "", /CPU 사용률순간값40%60초 실측/);
    await act(async () => { refresh.click(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.match(container.textContent || "", /CPU 사용률순간값40%60초 실측/);
    await act(async () => { refresh.click(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.match(container.textContent || "", /CPU 사용률순간값측정 중.*약 1~2분 후 표시/);
    await act(async () => { refresh.click(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.match(container.textContent || "", /CPU 사용률순간값30%60초 실측/);
    await act(async () => { refresh.click(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.match(container.textContent || "", /CPU 사용률순간값측정 중.*약 1~2분 후 표시/);
    await act(async () => { refresh.click(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.match(container.textContent || "", /CPU 사용률순간값20%60초 실측/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries(previous)) {
      if (key !== "fetch") globals[key] = value;
    }
    dom.window.close();
  }
});

domTest("UI ignores an older refresh response that arrives last", async () => {
  const { React, act, createRoot, SystemHealthPanel } =
    await loadReactHarness();
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
    url: "http://localhost/admin/system",
    },
  );
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previousGlobals = {
    window: globals.window,
    document: globals.document,
    navigator: globals.navigator,
    HTMLElement: globals.HTMLElement,
    sessionStorage: globals.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
    fetch: globalThis.fetch,
  };
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.navigator = dom.window.navigator;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.sessionStorage = dom.window.sessionStorage;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.sessionStorage.setItem("admin_pin", "health-test-pin");

  const baseline = summarizeSystemMetrics(sample());
  assert.ok(baseline.cpuCounter);
  const older = structuredClone(baseline);
  older.cpuCounter = {
    totalSeconds: baseline.cpuCounter.totalSeconds + 100,
    idleSeconds: baseline.cpuCounter.idleSeconds + 90,
    seriesFingerprint: baseline.cpuCounter.seriesFingerprint,
  };
  const newer = structuredClone(baseline);
  newer.cpuCounter = {
    totalSeconds: baseline.cpuCounter.totalSeconds + 200,
    idleSeconds: baseline.cpuCounter.idleSeconds + 100,
    seriesFingerprint: baseline.cpuCounter.seriesFingerprint,
  };
  const pending: Array<(response: Response) => void> = [];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({
        level: "healthy",
        metrics: baseline,
        services: healthyServices.map((service) => ({
          ...service,
          level: "healthy",
        })),
        sourceErrors: { metrics: null, management: null },
        checkedAt: "2026-08-20T14:00:00.000Z",
      });
    }
    return new Promise<Response>((resolve) => pending.push(resolve));
  }) as typeof fetch;

  const payload = (metrics: typeof baseline, checkedAt: string) =>
    Response.json({
      level: "healthy",
      metrics,
      services: healthyServices.map((service) => ({
        ...service,
        level: "healthy",
      })),
      sourceErrors: { metrics: null, management: null },
      checkedAt,
    });
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(SystemHealthPanel)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    const refresh = container.querySelector(
      'button[aria-label="서버 상태 새로고침"]',
    ) as HTMLButtonElement | null;
    assert.ok(refresh);
    await act(async () => {
      refresh.click();
      refresh.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
    assert.equal(pending.length, 2);
    await act(async () => {
      pending[1](payload(newer, "2026-08-20T14:02:00.000Z"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.match(container.textContent || "", /CPU 사용률순간값50%120초 실측/);
    await act(async () => {
      pending[0](payload(older, "2026-08-20T14:01:00.000Z"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.match(container.textContent || "", /CPU 사용률순간값50%120초 실측/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousGlobals.fetch;
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (key !== "fetch") globals[key] = value;
    }
    dom.window.close();
  }
});

domTest("high load and instant CPU render as informational without critical badges", async () => {
  const { React, act, createRoot, SystemHealthPanel } = await loadReactHarness();
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/admin/system",
  });
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = {
    window: globals.window,
    document: globals.document,
    navigator: globals.navigator,
    HTMLElement: globals.HTMLElement,
    sessionStorage: globals.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
    fetch: globalThis.fetch,
  };
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.navigator = dom.window.navigator;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.sessionStorage = dom.window.sessionStorage;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.sessionStorage.setItem("admin_pin", "health-test-pin");

  const metrics = summarizeSystemMetrics(
    sample().replace("node_load1 0.8", "node_load1 8"),
    previousSample(),
    1,
  );
  globalThis.fetch = (async () => Response.json({
    level: "healthy",
    metrics,
    services: healthyServices.map((service) => ({ ...service, level: "healthy" })),
    sourceErrors: { metrics: null, management: null },
    checkedAt: new Date().toISOString(),
  })) as typeof fetch;

  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(SystemHealthPanel));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const cards = [...container.querySelectorAll(".rounded-xl")];
    const cpuCard = cards.find((card) => card.textContent?.includes("CPU 사용률"));
    const loadCard = cards.find((card) => card.textContent?.includes("시스템 Load (1분)"));
    assert.ok(cpuCard);
    assert.ok(loadCard);
    assert.match(cpuCard.textContent || "", /CPU 사용률순간값40%.*알림 70% 5분 \/ 85% 3분/);
    assert.match(loadCard.textContent || "", /시스템 Load \(1분\)순간값8.*CPU와 별도/);
    assert.equal([...cpuCard.querySelectorAll("span")].some((span) => span.textContent === "긴급"), false);
    assert.equal([...loadCard.querySelectorAll("span")].some((span) => span.textContent === "긴급"), false);
    assert.match(container.textContent || "", /서버·DB Health정상/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries(previous)) {
      if (key !== "fetch") globals[key] = value;
    }
    dom.window.close();
  }
});

test("route degrades overall health when Metrics is unavailable", async () => {
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) return new Response("unavailable", { status: 503 });
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.level, "warning");
  assert.equal(payload.metrics, null);
  assert.match(payload.sourceErrors.metrics, /503/);
});

test("route degrades overall health when Management Health is unavailable", async () => {
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) return new Response(sample(), { status: 200 });
    return new Response("unavailable", { status: 503 });
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.level, "warning");
  assert.ok(payload.services.every((service: { level: string }) => service.level === "unknown"));
  assert.match(payload.sourceErrors.management, /503/);
});

test("route does not report healthy for HTTP 200 unrelated metrics", async () => {
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) return new Response("unrelated_metric 1\n", { status: 200 });
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.level, "warning");
  assert.equal(payload.metrics.level, "unknown");
  assert.equal(payload.sourceErrors.metrics, null);
});

domTest("UI marks retained data stale after a successful load then refresh failure", async () => {
  const { React, act, createRoot, SystemHealthPanel } = await loadReactHarness();
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/admin/system",
  });
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = {
    window: globals.window,
    document: globals.document,
    navigator: globals.navigator,
    HTMLElement: globals.HTMLElement,
    sessionStorage: globals.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
    fetch: globalThis.fetch,
  };
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.navigator = dom.window.navigator;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.sessionStorage = dom.window.sessionStorage;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.sessionStorage.setItem("admin_pin", "health-test-pin");

  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls > 1) return new Response("unavailable", { status: 503 });
    return Response.json({
      level: "healthy",
      metrics: summarizeSystemMetrics(sample(), previousSample(), 1),
      services: healthyServices.map((service) => ({ ...service, level: "healthy" })),
      sourceErrors: { metrics: null, management: null },
      checkedAt: new Date().toISOString(),
    });
  }) as typeof fetch;

  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(SystemHealthPanel));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const initialText = container.textContent || "";
    assert.match(initialText, /정상/);
    assert.match(initialText, /CPU 사용률/);
    assert.match(initialText, /시스템 Load \(1분\)/);
    assert.doesNotMatch(initialText, /CPU 부하 \(1분\)/);
    const refresh = container.querySelector('button[aria-label="서버 상태 새로고침"]') as HTMLButtonElement | null;
    assert.ok(refresh);
    await act(async () => {
      refresh.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.match(container.textContent || "", /최근 갱신 실패/);
    assert.match(container.textContent || "", /이전 정상값일 수 있음/);
    assert.match(container.textContent || "", /주의/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries(previous)) {
      if (key !== "fetch") globals[key] = value;
    }
    dom.window.close();
  }
});

domTest("UI shows date and age when checkedAt is stale", async () => {
  const { React, act, createRoot, SystemHealthPanel } = await loadReactHarness();
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/admin/system",
  });
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = {
    window: globals.window,
    document: globals.document,
    navigator: globals.navigator,
    HTMLElement: globals.HTMLElement,
    sessionStorage: globals.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
    fetch: globalThis.fetch,
  };
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.navigator = dom.window.navigator;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.sessionStorage = dom.window.sessionStorage;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.sessionStorage.setItem("admin_pin", "health-test-pin");

  const oldCheckedAt = new Date(Date.now() - 26 * 60 * 60 * 1000);
  globalThis.fetch = (async () => Response.json({
    level: "healthy",
    metrics: summarizeSystemMetrics(sample(), previousSample(), 1),
    services: healthyServices.map((service) => ({ ...service, level: "healthy" })),
    sourceErrors: { metrics: null, management: null },
    checkedAt: oldCheckedAt.toISOString(),
  })) as typeof fetch;

  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(SystemHealthPanel));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const text = container.textContent || "";
    assert.match(text, /데이터 지연/);
    assert.match(text, /1일 2시간 전/);
    assert.match(text, new RegExp(String(oldCheckedAt.getFullYear())));
    assert.match(text, /주의/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries(previous)) {
      if (key !== "fetch") globals[key] = value;
    }
    dom.window.close();
  }
});
