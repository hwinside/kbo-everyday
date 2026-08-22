import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { JSDOM } from "jsdom";
import { NextRequest } from "next/server";
import { GET } from "../../src/app/api/admin/system-health/route";
import {
  computeInstantCpuFromStore,
  computeStaleCpuFromStore,
  cpuUsedPercentFromSnapshots,
  parsePrometheusText,
  summarizeSystemMetrics,
} from "../../src/lib/admin/system-health";

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

// 2026-08-22 라이브 공백 재현 회귀(하린아빠 13:27 스크린샷 → 13:31:20 관측으로 재현).
// cron 회차가 하나 누락되면 저장 최신 나이가 107초까지 밀려 90초 freshness 상한을 넘기고,
// 그 순간 화면이 "측정 중"으로 비었다. 즉시값은 여전히 null 이어야 하지만(계약 유지),
// 직전 실측값은 내려보내 화면을 비우지 않는다.
test("stored baseline older than 90s yields no instant value but a stale value (2026-08-22 gap)", () => {
  const fp = "cpu0";
  const now = Date.parse("2026-08-22T04:31:20.000Z");
  const current = { totalSeconds: 306, idleSeconds: 203.6, seriesFingerprint: fp };
  const stored = [
    { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: fp, capturedAtMs: now - 107_100 },
    { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now - 167_200 },
    { totalSeconds: 300, idleSeconds: 200, seriesFingerprint: fp, capturedAtMs: now - 226_800 },
  ];

  assert.equal(
    computeInstantCpuFromStore(stored, current, now),
    null,
    "90초 초과 baseline 을 현재값으로 쓰면 안 된다(기존 계약 유지)",
  );

  const stale = computeStaleCpuFromStore(stored, current, now);
  assert.ok(stale, "cron 누락 구간에서도 직전 실측값은 있어야 한다");
  assert.ok(Math.abs(stale.usedPercent - 40) < 0.001);
  assert.equal(stale.windowSeconds, 60.1); // 저장분끼리의 창
  assert.equal(stale.sampleEndedAtMs, now - 107_100, "종료 시각은 저장 시각이지 now 가 아니다");
});

// 삼순 3차 P0-2 계약 유지: stale 경로도 now 를 종료 시각으로 재각인하지 않고,
// 상한(5분)을 넘기면 측정 불능으로 fail-close 한다.
test("computeStaleCpuFromStore fails closed beyond the stale cap and never stamps now", () => {
  const fp = "cpu0";
  const now = Date.parse("2026-08-22T04:31:20.000Z");
  const current = { totalSeconds: 306, idleSeconds: 203.6, seriesFingerprint: fp };
  const frozen = [
    { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: fp, capturedAtMs: now - 301_000 },
    { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now - 361_000 },
  ];
  assert.equal(computeStaleCpuFromStore(frozen, current, now), null, "5분 초과는 직전값도 보여주지 않는다");

  // 창 상한(150초) 초과 쌍만 있으면 장기평균을 직전값으로 위장하지 않는다
  const wideWindow = [
    { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: fp, capturedAtMs: now - 100_000 },
    { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now - 260_000 },
  ];
  assert.equal(computeStaleCpuFromStore(wideWindow, current, now), null, "창 160초는 순간값으로 부적합");

  // 빈 저장소는 null
  assert.equal(computeStaleCpuFromStore([], current, now), null);
});

// 삼순 #1283 P1: 최신 row 의 쌍이 실패했다고 **과거 series** 로 내려가 탐색하면
// "fingerprint 불일치 fail-close" 계약이 우회된다. stale 계산은 현재 series 에만 결속된다.
test("computeStaleCpuFromStore binds to the current series (no past-series fallback)", () => {
  const now = Date.parse("2026-08-22T04:31:20.000Z");
  const newFp = "cpu-new";
  const oldFp = "cpu-old";
  const current = { totalSeconds: 10, idleSeconds: 6, seriesFingerprint: newFp }; // reset 직후

  // [new-fp 최신(페어 불가), old-fp, old-fp] — 과거 old 쌍은 유효하지만 써서는 안 된다
  const afterReset = [
    { totalSeconds: 8, idleSeconds: 5, seriesFingerprint: newFp, capturedAtMs: now - 100_000 },
    { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: oldFp, capturedAtMs: now - 160_000 },
    { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: oldFp, capturedAtMs: now - 220_000 },
  ];
  assert.equal(
    computeStaleCpuFromStore(afterReset, current, now),
    null,
    "현재 series 에 페어가 없으면 과거 series 쌍으로 대체하면 안 된다",
  );

  // 최신 저장분이 현재와 다른 series 면(current 가 바뀜) 즉시 null
  const staleSeriesOnly = [
    { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: oldFp, capturedAtMs: now - 100_000 },
    { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: oldFp, capturedAtMs: now - 160_000 },
  ];
  assert.equal(
    computeStaleCpuFromStore(staleSeriesOnly, current, now),
    null,
    "최신 저장분이 현재 series 가 아니면 fail-close",
  );

  // 동일 series 로 유효 쌍이 있으면 정상 반환(위 반례가 과방어가 아님을 증명)
  const healthy = [
    { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: newFp, capturedAtMs: now - 100_000 },
    { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: newFp, capturedAtMs: now - 160_000 },
  ];
  assert.ok(computeStaleCpuFromStore(healthy, { ...current, seriesFingerprint: newFp }, now));
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

// 삼순 3차 P0-1: current가 최신 저장분과 정확히 동일할 때만 과거 쌍을 쓴다.
// reset/fingerprint 변경으로 첫 쌍이 실패했다고 과거 rate를 실시간처럼 보여주면 안 된다.
test("computeInstantCpuFromStore never falls back to a past pair when current diverges", () => {
  const fp = "cpu0";
  const now = Date.parse("2026-08-21T10:00:00.000Z");
  const storedPair = [
    { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: fp, capturedAtMs: now - 20_000 }, // C
    { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now - 80_000 }, // B
  ];
  // current가 리셋(counter 역전) — 과거 C↔B 가 유효해도 null 이어야 한다
  assert.equal(
    computeInstantCpuFromStore(storedPair, { totalSeconds: 10, idleSeconds: 6, seriesFingerprint: fp }, now),
    null,
  );
  // current fingerprint 변경 — 마찬가지로 null
  assert.equal(
    computeInstantCpuFromStore(
      storedPair,
      { totalSeconds: 306, idleSeconds: 203.6, seriesFingerprint: `${fp};cpu2|mode=idle` },
      now,
    ),
    null,
  );
});

// 삼순 3차 P0-2: current=C 가 정지했고 store 최신=B 일 때
// sampleEndedAt=now 로 매번 찍어 90초 freshness 를 150초 window 까지 우회하면 안 된다.
test("computeInstantCpuFromStore caps the current↔stored path by stored freshness", () => {
  const fp = "cpu0";
  const now = Date.parse("2026-08-21T10:00:00.000Z");
  const current = { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: fp };
  // B 가 91초 전 — 창(91s)은 150s 이내지만 baseline 신선도가 90초를 넘으므로 null
  assert.equal(
    computeInstantCpuFromStore(
      [{ totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now - 91_000 }],
      current,
      now,
    ),
    null,
  );
  // 89초 전이면 정상 계산
  const ok = computeInstantCpuFromStore(
    [{ totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now - 89_000 }],
    current,
    now,
  );
  assert.ok(ok);
  assert.equal(ok.sampleEndedAtMs, now);
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
      return Response.json([
        { key: "cpuSnap_a", value: { t: Date.now() - 60_000, fp, total: 300, idle: 200 } },
      ]);
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
      return Response.json([
        { key: "cpuSnap_c", value: { t: cAtMs, fp, total: 302, idle: 201.2 } }, // 현재 counter와 동일 tick
        { key: "cpuSnap_b", value: { t: cAtMs - 60_000, fp, total: 300, idle: 200 } },
      ]);
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
      return Response.json([
        { key: "cpuSnap_c", value: { t: Date.now() - 130_000, fp, total: 302, idle: 201.2 } }, // 현재와 동일 = 2분 이상 정지
        { key: "cpuSnap_b", value: { t: Date.now() - 190_000, fp, total: 300, idle: 200 } },
      ]);
    }
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(payload.metrics.cpuUsedPercent, null); // 멈춘 counter를 현재값으로 위장 금지
  assert.equal(payload.metrics.cpuSampleEndedAt, null);
});

// 삼순 #1283 P0 회귀: route 가 stale 필드를 실제로 채우는지(배선 단절 검출).
// helper 만 직접 호출하는 테스트는 import-만-하고-미호출 상태를 못 잡았다.
// 2026-08-22 라이브 재현 값(저장 최신 나이 107초)을 그대로 쓴다.
test("route fills stale CPU fields when the baseline is 107s old (2026-08-22 gap, wiring)", async () => {
  const fp = "cpu=0|mode=idle;cpu=0|mode=user;cpu=1|mode=idle;cpu=1|mode=user";
  const now = Date.now();
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) {
      return new Response(sample(), { status: 200 });
    }
    if (url.includes("api.vercel.com/v1/edge-config")) {
      // 현재 counter(total 302/idle 201.2)보다 이전 값들만 있고, 최신이 107초 전 → 90초 상한 초과
      return Response.json([
        { key: "cpuSnap_c", value: { t: now - 107_100, fp, total: 300, idle: 200 } },
        { key: "cpuSnap_b", value: { t: now - 167_200, fp, total: 298, idle: 198.8 } },
      ]);
    }
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(payload.metrics.cpuUsedPercent, null, "90초 초과 baseline 은 현재값이 아니다");
  assert.equal(payload.metrics.cpuSampleEndedAt, null);
  assert.ok(
    payload.metrics.cpuStalePercent !== null && payload.metrics.cpuStalePercent !== undefined,
    "route 가 stale 필드를 실제로 채워야 한다(import 만 하고 미호출이면 이 assertion 이 죽는다)",
  );
  assert.ok(Math.abs(payload.metrics.cpuStalePercent - 40) < 0.001);
  const endedAtMs = Date.parse(payload.metrics.cpuStaleEndedAt);
  assert.ok(Number.isFinite(endedAtMs));
  assert.ok(Math.abs(endedAtMs - (now - 107_100)) < 1_500, "종료 시각은 저장 시각이지 now 가 아니다");
  assert.ok(now - endedAtMs > 90_000, "stale 값은 90초보다 오래된 측정임을 밝혀야 한다");
});

// 현재값이 살아있으면 stale 은 반드시 null (배타 계약).
test("route keeps stale fields null whenever the instant value is present", async () => {
  const fp = "cpu=0|mode=idle;cpu=0|mode=user;cpu=1|mode=idle;cpu=1|mode=user";
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) {
      return new Response(sample(), { status: 200 });
    }
    if (url.includes("api.vercel.com/v1/edge-config")) {
      return Response.json([
        { key: "cpuSnap_a", value: { t: Date.now() - 60_000, fp, total: 300, idle: 200 } },
      ]);
    }
    return Response.json(healthyServices);
  });
  const payload = await response.json();
  assert.equal(payload.metrics.cpuUsedPercent, 40);
  assert.equal(payload.metrics.cpuStalePercent, null, "현재값과 stale 은 배타여야 한다");
  assert.equal(payload.metrics.cpuStaleEndedAt, null);
});

test("route rejects a window longer than the 150s cap", async () => {
  const fp = "cpu=0|mode=idle;cpu=0|mode=user;cpu=1|mode=idle;cpu=1|mode=user";
  const response = await routeWith(async (input) => {
    const url = String(input);
    if (url.includes("privileged/metrics")) {
      return new Response(sample(), { status: 200 });
    }
    if (url.includes("api.vercel.com/v1/edge-config")) {
      return Response.json([
        { key: "cpuSnap_a", value: { t: Date.now() - 151_000, fp, total: 300, idle: 200 } },
      ]);
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

// 삼순 4·5차 P1: Vercel cron 은 중복·동시 실행될 수 있고 Edge Config PATCH 에는 CAS 가 없다.
// 단일 배열 key RMW 를 폐기하고 스냅샷 1개 = 독립 key 1개 · **create 전용(non-overwrite append)** 로 전환 —
// 삼순 반례 read/read/write(D)/write(C) exact interleaving 과 동일 counter 양방향 write 를
// in-memory 스토어(create 실패 의미론 포함)로 재현해 고정한다.

type WireItem = { key: string; value: { t: number; fp: string; total: number; idle: number } };

/** in-memory Edge Config 스토어 — GET /items 는 배열, PATCH /items 는 create/delete 적용(create 는 기존 key 있으면 실패). */
function makeFakeEdgeConfig(initial: WireItem[] = []) {
  const store = new Map<string, WireItem["value"]>(initial.map((item) => [item.key, item.value]));
  const log: Array<{ method: string; ops?: Array<{ operation: string; key: string }> }> = [];
  const handler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("api.vercel.com/v1/edge-config")) throw new Error(`unexpected call ${url}`);
    const method = (init?.method || "GET").toUpperCase();
    if (method === "GET") {
      log.push({ method });
      return Response.json([...store.entries()].map(([key, value]) => ({ key, value })));
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      items?: Array<{ operation: string; key: string; value?: WireItem["value"] }>;
    };
    log.push({ method, ops: (body.items ?? []).map((op) => ({ operation: op.operation, key: op.key })) });
    // 실제 Edge Config 계약: create 는 이미 존재하는 key 에 대해 실패하며 배치 전체가 거부된다.
    for (const op of body.items ?? []) {
      if (op.operation === "create" && store.has(op.key)) return new Response("conflict", { status: 400 });
      if (op.operation === "upsert") return new Response("upsert forbidden in append design", { status: 400 });
    }
    for (const op of body.items ?? []) {
      if (op.operation === "create" && op.value) store.set(op.key, op.value);
      if (op.operation === "delete") store.delete(op.key);
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { store, log, handler };
}

async function withFakeEdgeConfig<T>(
  fake: ReturnType<typeof makeFakeEdgeConfig>,
  run: () => Promise<T>,
): Promise<T> {
  const previousToken = process.env.VERCEL_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.VERCEL_TOKEN = "***";
  globalThis.fetch = fake.handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = previousToken;
  }
}

// 삼순 반례 exact interleaving: C/D 가 같은 B 를 본 상태에서 D 가 먼저 쓰고, 느린 C 가 나중에 쓴다.
// 종전 설계에선 마지막 write(C) 가 저장소를 C 로 퇴행시켰다. 독립 key 설계에선 C 의 쓰기가
// D 의 key 를 건드릴 수 없어 최종 최신값이 항상 D 로 유지된다.
test("independent-key commits survive the read/read/write(D)/write(C) interleaving (no regression)", async () => {
  const { commitCpuSnapshot, loadRecentCpuSnapshots, cpuSnapshotKey } = await import(
    "../../src/lib/admin/cpu-snapshot-store"
  );
  const fp = "cpu0";
  const now = Date.now();
  const B = { totalSeconds: 300, idleSeconds: 200, seriesFingerprint: fp, capturedAtMs: now - 120_000 };
  const C = { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now - 60_000 };
  const D = { totalSeconds: 304, idleSeconds: 202.4, seriesFingerprint: fp, capturedAtMs: now };
  const fake = makeFakeEdgeConfig([{ key: cpuSnapshotKey(B), value: { t: B.capturedAtMs, fp, total: 300, idle: 200 } }]);

  await withFakeEdgeConfig(fake, async () => {
    // 두 작업자 모두 B 만 있는 스토어를 읽은 후(읽기는 쓰기 경로와 무관), 빠른 D → 느린 C 순으로 쓴다
    const dResult = await commitCpuSnapshot(D);
    assert.equal(dResult.ok, true);
    const cResult = await commitCpuSnapshot(C); // stale 작업자의 느린 write
    assert.equal(cResult.ok, true);

    // 핵심 계약: 마지막 write 가 C 였는데도 최신값은 D — 퇴행 없음
    const rows = await loadRecentCpuSnapshots();
    assert.ok(rows && rows.length >= 2);
    assert.equal(rows![0].totalSeconds, 304, "느린 작업자의 stale write 가 최신값을 되돌리면 안 된다");
    assert.equal(rows![1].totalSeconds, 302);

    // 구조 보증: 모든 쓰기는 create 전용이고, 어떤 PATCH 도 자기 key 밖의 스냅샷 key 를 쓰지 않는다
    const writes = fake.log.flatMap((entry) => entry.ops ?? []).filter((op) => op.operation !== "delete");
    const allowed = new Set([cpuSnapshotKey(C), cpuSnapshotKey(D)]);
    for (const op of writes) {
      assert.equal(op.operation, "create", "append 설계에서 upsert 는 금지다");
      assert.ok(allowed.has(op.key), `자기 key 외 쓰기 금지: ${op.key}`);
    }
  });
});

// 삼순 5차 P1 핵심 회귀: 동일 counter 중복 cron 의 **양방향** write.
// 종전(upsert LWW)엔 늦은 write(옆 t)가 저장된 시각을 퇴행시켰다. create 전용에선
// 먼저 쓰인 값이 불변이므로 어느 순서로도 항목 1개 · freshness(저장 t) 무퇴행이다.
test("same-counter duplicate writes are idempotent in both orders (immutable value, no freshness regression)", async () => {
  const { commitCpuSnapshot, loadRecentCpuSnapshots, cpuSnapshotKey } = await import(
    "../../src/lib/admin/cpu-snapshot-store"
  );
  const fp = "cpu0";
  const now = Date.now();
  const tOld = now - 5_000;
  const sampleOld = { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: tOld };
  const sampleNew = { ...sampleOld, capturedAtMs: now }; // 같은 counter 를 다른 시각에 잡은 중복 cron
  assert.equal(cpuSnapshotKey(sampleOld), cpuSnapshotKey(sampleNew), "동일 counter 는 시각과 무관하게 동일 key 여야 한다");

  // 순방향: 옆 t 먼저 → 새 t 나중. 저장값은 첫 write(옆 t) 그대로.
  const forward = makeFakeEdgeConfig();
  await withFakeEdgeConfig(forward, async () => {
    const first = await commitCpuSnapshot(sampleOld);
    assert.equal(first.ok, true);
    assert.equal(first.wrote, true);
    const second = await commitCpuSnapshot(sampleNew);
    assert.equal(second.ok, true, "중복 write 는 멱등 성공이어야 한다");
    assert.equal(second.wrote, false, "두 번째 write 는 create 실패(불변)로 아무것도 쓰지 않는다");
    const rows = await loadRecentCpuSnapshots();
    assert.ok(rows);
    assert.equal(rows!.length, 1, "동일 counter 중복 적재는 항목 1개로 수렴해야 한다");
    assert.equal(rows![0].capturedAtMs, tOld, "저장 시각은 첫 write 그대로여야 한다");
  });

  // 역순(삼순 반례): 새 t 먼저 → 늦은 작업자가 옆 t 로 나중에 쓴다.
  // 종전 LWW upsert 는 여기서 시각을 tOld 로 퇴행시켰다 — create 전용은 새 t 를 지킨다.
  const reverse = makeFakeEdgeConfig();
  await withFakeEdgeConfig(reverse, async () => {
    assert.equal((await commitCpuSnapshot(sampleNew)).ok, true);
    const late = await commitCpuSnapshot(sampleOld); // 늦게 도착한 옆 시각의 stale write
    assert.equal(late.ok, true);
    assert.equal(late.wrote, false);
    const rows = await loadRecentCpuSnapshots();
    assert.ok(rows);
    assert.equal(rows!.length, 1);
    assert.equal(rows![0].capturedAtMs, now, "늦은 옆-t write 가 저장 시각을 퇴행시키면 안 된다");
  });
});

// sha256 충돌(사실상 불가) 방어 경로: 내 key 를 다른 counter 가 선점했을 때도
// 기존 항목을 건드리지 않고 폴백 key 로 append 한다.
test("digest-collision fallback appends under a suffixed key without touching the occupant", async () => {
  const { commitCpuSnapshot, loadRecentCpuSnapshots, cpuSnapshotKey } = await import(
    "../../src/lib/admin/cpu-snapshot-store"
  );
  const fp = "cpu0";
  const now = Date.now();
  const incoming = { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now };
  const key = cpuSnapshotKey(incoming);
  const foreign = { t: now - 60_000, fp: "other", total: 999, idle: 500 }; // 충돌 시뮬: 다른 counter 가 내 key 선점
  const fake = makeFakeEdgeConfig([{ key, value: foreign }]);

  await withFakeEdgeConfig(fake, async () => {
    const result = await commitCpuSnapshot(incoming);
    assert.equal(result.ok, true, "충돌에서도 폴백 key 로 적재는 성공해야 한다");
    assert.deepEqual(fake.store.get(key), foreign, "선점 항목은 어떤 경우에도 변경되면 안 된다");
    assert.ok(fake.store.has(`${key}_c1`), "폴백 key(_c1)에 append 돼야 한다");
    const rows = await loadRecentCpuSnapshots();
    assert.ok(rows);
    assert.ok(rows!.some((row) => row.totalSeconds === 302), "내 스냅샷이 조회돼야 한다");
    assert.ok(rows!.some((row) => row.totalSeconds === 999), "선점 스냅샷도 그대로 조회돼야 한다");
  });
});

test("GC deletes only snapshots older than the age cap and the legacy array key", async () => {
  const { commitCpuSnapshot, cpuSnapshotKey, CPU_SNAPSHOTS_LEGACY_KEY } = await import(
    "../../src/lib/admin/cpu-snapshot-store"
  );
  const fp = "cpu0";
  const now = Date.now();
  const stale = { totalSeconds: 100, idleSeconds: 60, seriesFingerprint: fp, capturedAtMs: now - 11 * 60_000 };
  const fresh = { totalSeconds: 300, idleSeconds: 200, seriesFingerprint: fp, capturedAtMs: now - 60_000 };
  const incoming = { totalSeconds: 302, idleSeconds: 201.2, seriesFingerprint: fp, capturedAtMs: now };
  const fake = makeFakeEdgeConfig([
    { key: cpuSnapshotKey(stale), value: { t: stale.capturedAtMs, fp, total: 100, idle: 60 } },
    { key: cpuSnapshotKey(fresh), value: { t: fresh.capturedAtMs, fp, total: 300, idle: 200 } },
    { key: CPU_SNAPSHOTS_LEGACY_KEY, value: { t: 0, fp: "legacy", total: 0, idle: 0 } },
  ]);

  await withFakeEdgeConfig(fake, async () => {
    assert.equal((await commitCpuSnapshot(incoming)).ok, true);
    assert.ok(!fake.store.has(cpuSnapshotKey(stale)), "10분 초과 스냅샷은 GC 돼야 한다");
    assert.ok(!fake.store.has(CPU_SNAPSHOTS_LEGACY_KEY), "레거시 배열 key 는 GC 돼야 한다");
    assert.ok(fake.store.has(cpuSnapshotKey(fresh)), "신선한 스냅샷은 삭제되면 안 된다");
    assert.ok(fake.store.has(cpuSnapshotKey(incoming)));
  });
});

// E2E 실측으로 발견한 결함 회귀: Edge Config 는 키 부재 시 404 가 아니라 **204 No Content**(빈 본문)를
// 반환한다. 204 에 response.json() 을 호출하면 예외가 나서 "조회 실패(null)"로 오판되고,
// cron 이 첫 적재를 영영 못 한다(E2E 1회차 500 으로 재현됨).
test("loadRecentCpuSnapshots treats 204/empty body as an empty store, not a failure", async () => {
  const { loadRecentCpuSnapshots } = await import("../../src/lib/admin/cpu-snapshot-store");
  const previousToken = process.env.VERCEL_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.VERCEL_TOKEN = "***";
  try {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    assert.deepEqual(await loadRecentCpuSnapshots(), [], "204 는 빈 저장소여야 한다");

    globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch;
    assert.deepEqual(await loadRecentCpuSnapshots(), [], "빈 본문 200 도 빈 저장소여야 한다");

    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    assert.equal(await loadRecentCpuSnapshots(), null, "파싱 불가 본문은 판정 불능(null)이어야 한다");

    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    assert.equal(await loadRecentCpuSnapshots(), null, "5xx 는 판정 불능(null)이어야 한다");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = previousToken;
  }
});
