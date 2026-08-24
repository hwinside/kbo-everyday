import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  commitCpuSnapshot,
  CPU_SNAPSHOT_REDIS_KEY,
  CPU_SNAPSHOT_RETENTION_MS,
  loadRecentCpuSnapshots,
} from "../../src/lib/admin/cpu-snapshot-store-redis";

interface FakeRedis {
  rows: Map<string, number>;
  commands: Array<Array<string | number>>;
  fetch: typeof fetch;
}

function makeFakeRedis(initial: Array<{ member: string; score: number }> = []): FakeRedis {
  const rows = new Map(initial.map((row) => [row.member, row.score]));
  const commands: Array<Array<string | number>> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://redis.test");
    assert.equal((init?.method || "GET").toUpperCase(), "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer redis-token");
    const command = JSON.parse(String(init?.body)) as Array<string | number>;
    commands.push(command);
    const name = String(command[0]).toUpperCase();

    if (name === "ZADD") {
      assert.equal(command[1], CPU_SNAPSHOT_REDIS_KEY);
      assert.equal(command[2], "NX");
      const score = Number(command[3]);
      const member = String(command[4]);
      if (rows.has(member)) return Response.json({ result: 0 });
      rows.set(member, score);
      return Response.json({ result: 1 });
    }
    if (name === "ZRANGEBYSCORE") {
      assert.equal(command[1], CPU_SNAPSHOT_REDIS_KEY);
      const min = Number(command[2]);
      const result = [...rows.entries()]
        .filter(([, score]) => score >= min)
        .sort((left, right) => left[1] - right[1])
        .flatMap(([member, score]) => [member, String(score)]);
      return Response.json({ result });
    }
    if (name === "ZREMRANGEBYSCORE") {
      assert.equal(command[1], CPU_SNAPSHOT_REDIS_KEY);
      const max = Number(command[3]);
      let removed = 0;
      for (const [member, score] of rows) {
        if (score <= max) {
          rows.delete(member);
          removed += 1;
        }
      }
      return Response.json({ result: removed });
    }
    throw new Error(`unexpected command ${name}`);
  }) as typeof fetch;
  return { rows, commands, fetch: fakeFetch };
}

async function withRedis<T>(fake: FakeRedis, run: () => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test/";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  globalThis.fetch = fake.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
}

const fp = "cpu0";
const snap = (total: number, idle: number, capturedAtMs: number) => ({
  totalSeconds: total,
  idleSeconds: idle,
  seriesFingerprint: fp,
  capturedAtMs,
});

test("production store uses only Upstash REST and returns newest-first snapshots", async () => {
  const fake = makeFakeRedis();
  const now = Date.now();
  await withRedis(fake, async () => {
    assert.deepEqual(await commitCpuSnapshot(snap(300, 200, now - 60_000)), { ok: true, wrote: true });
    assert.deepEqual(await commitCpuSnapshot(snap(302, 201.2, now)), { ok: true, wrote: true });
    const rows = await loadRecentCpuSnapshots();
    assert.deepEqual(rows?.map((row) => row.totalSeconds), [302, 300]);
    assert.ok(fake.commands.every((command) => !String(command[1]).includes("edge-config")));
  });
});

test("duplicate counter identity is immutable in both write orders", async () => {
  const now = Date.now();
  for (const [firstAt, secondAt] of [
    [now - 5_000, now],
    [now, now - 5_000],
  ]) {
    const fake = makeFakeRedis();
    await withRedis(fake, async () => {
      assert.deepEqual(await commitCpuSnapshot(snap(302, 201.2, firstAt)), { ok: true, wrote: true });
      assert.deepEqual(await commitCpuSnapshot(snap(302, 201.2, secondAt)), { ok: true, wrote: false });
      const rows = await loadRecentCpuSnapshots();
      assert.equal(rows?.length, 1);
      assert.equal(rows?.[0].capturedAtMs, firstAt, "duplicate must not move the first observation timestamp");
    });
  }
});

test("late stale append cannot replace or hide a newer counter", async () => {
  const fake = makeFakeRedis();
  const now = Date.now();
  await withRedis(fake, async () => {
    await commitCpuSnapshot(snap(304, 202.4, now));
    await commitCpuSnapshot(snap(302, 201.2, now - 60_000));
    const rows = await loadRecentCpuSnapshots();
    assert.deepEqual(rows?.map((row) => row.totalSeconds), [304, 302]);
  });
});

test("GC removes only rows outside the ten-minute retention window", async () => {
  const now = Date.now();
  const staleMember = JSON.stringify({ fp, total: 100, idle: 60 });
  const freshMember = JSON.stringify({ fp, total: 300, idle: 200 });
  const fake = makeFakeRedis([
    { member: staleMember, score: now - CPU_SNAPSHOT_RETENTION_MS - 1 },
    { member: freshMember, score: now - 60_000 },
  ]);
  await withRedis(fake, async () => {
    assert.equal((await commitCpuSnapshot(snap(302, 201.2, now))).ok, true);
    assert.equal(fake.rows.has(staleMember), false);
    assert.equal(fake.rows.has(freshMember), true);
  });
});

test("cron → Redis → admin route production seam keeps 1-minute freshness and health reads are read-only", async () => {
  const fake = makeFakeRedis();
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    ADMIN_PIN: process.env.ADMIN_PIN,
    ADMIN_PIN_HASH: process.env.ADMIN_PIN_HASH,
    CRON_SECRET: process.env.CRON_SECRET,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_MANAGEMENT_TOKEN: process.env.SUPABASE_MANAGEMENT_TOKEN,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  process.env.ADMIN_PIN = "health-test-pin";
  delete process.env.ADMIN_PIN_HASH;
  process.env.CRON_SECRET = "cron-test-secret";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://health-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  process.env.SUPABASE_MANAGEMENT_TOKEN = "management-token";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";

  let metricsCall = 0;
  const metrics = (idle: number, user: number) => `
node_cpu_seconds_total{cpu="0",mode="idle"} ${idle}
node_cpu_seconds_total{cpu="0",mode="user"} ${user}
node_load1 0.5
node_memory_MemTotal_bytes 1000
node_memory_MemFree_bytes 200
node_memory_Buffers_bytes 100
node_memory_Cached_bytes 100
node_filesystem_avail_bytes{device="/dev/root",fstype="ext4",mountpoint="/"} 300
node_filesystem_size_bytes{device="/dev/root",fstype="ext4",mountpoint="/"} 1000
pg_up 1
pgbouncer_up 1
`;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "https://redis.test") return fake.fetch(input, init);
    if (url.includes("privileged/metrics")) {
      metricsCall += 1;
      return new Response(metricsCall === 1 ? metrics(200, 100) : metrics(201.2, 100.8));
    }
    if (url.includes("api.supabase.com")) {
      return Response.json(["db", "rest", "auth", "storage"].map((name) => ({ name, status: "ACTIVE_HEALTHY" })));
    }
    throw new Error(`unexpected call ${url}`);
  }) as typeof fetch;

  try {
    const { GET: cronGet } = await import("../../src/app/api/cron/system-metrics-snapshot/route");
    const cronResponse = await cronGet(
      new NextRequest("http://localhost/api/cron/system-metrics-snapshot", {
        headers: { authorization: "Bearer cron-test-secret" },
      }),
    );
    assert.equal(cronResponse.status, 200);
    assert.equal((await cronResponse.json()).inserted, true);

    // Model the real one-minute cadence before the admin request arrives.
    for (const [member] of fake.rows) fake.rows.set(member, Date.now() - 60_000);
    const commandsBeforeHealth = fake.commands.length;

    const { GET: healthGet } = await import("../../src/app/api/admin/system-health/route");
    const healthResponse = await healthGet(
      new NextRequest("http://localhost/api/admin/system-health", {
        headers: { "x-admin-pin": "health-test-pin" },
      }),
    );
    const payload = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.ok(Math.abs(payload.metrics.cpuUsedPercent - 40) < 0.001);
    assert.ok(payload.metrics.cpuSampleSeconds >= 59 && payload.metrics.cpuSampleSeconds <= 61);
    const healthCommands = fake.commands.slice(commandsBeforeHealth).map((command) => command[0]);
    assert.deepEqual(healthCommands, ["ZRANGEBYSCORE"], "health path must stay read-only");
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("provider failures fail closed and never write to legacy Edge Config", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls += 1;
    assert.equal(String(input), "https://redis.test");
    return new Response("down", { status: 500 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await commitCpuSnapshot(snap(302, 201.2, Date.now())), { ok: false, wrote: false });
    assert.equal(await loadRecentCpuSnapshots(), null);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});
