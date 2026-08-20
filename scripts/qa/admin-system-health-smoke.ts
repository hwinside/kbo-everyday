import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { NextRequest } from "next/server";
import SystemHealthPanel from "../../src/app/admin/system/SystemHealthPanel";
import { GET } from "../../src/app/api/admin/system-health/route";
import { parsePrometheusText, summarizeSystemMetrics } from "../../src/lib/admin/system-health";

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
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_MANAGEMENT_TOKEN: process.env.SUPABASE_MANAGEMENT_TOKEN,
  };
  process.env.ADMIN_PIN = "health-test-pin";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://health-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.SUPABASE_MANAGEMENT_TOKEN = "test-management-token";
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

test("route derives actual CPU from two counter snapshots and keeps high load separate", async () => {
  let metricCalls = 0;
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) {
      metricCalls += 1;
      return new Response(
        metricCalls === 1 ? previousSample() : sample().replace("node_load1 0.8", "node_load1 8"),
        { status: 200 },
      );
    }
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(metricCalls, 2);
  assert.equal(payload.level, "healthy");
  assert.equal(payload.metrics.cpuUsedPercent, 40);
  assert.equal(payload.metrics.load1, 8);
  assert.equal(payload.metrics.load1PerCore, 4);
  assert.ok(payload.metrics.cpuSampleSeconds >= 1);
});

test("high load and instant CPU render as informational without critical badges", async () => {
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
  const { createRoot } = await import("react-dom/client");
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

test("UI marks retained data stale after a successful load then refresh failure", async () => {
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
  const { createRoot } = await import("react-dom/client");
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

test("UI shows date and age when checkedAt is stale", async () => {
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
  const { createRoot } = await import("react-dom/client");
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
