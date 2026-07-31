/**
 * Actual `/api/cron/roster-moves` collection-stage deadline regression.
 * KBO response/body stalls and malformed/HTTP failures must terminate inside
 * one absolute budget before any Supabase read/write/RPC is created.
 */
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.CRON_SECRET = "roster-deadline-smoke";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "smoke-service-role-key";

function neverResponse(): Promise<Response> {
  return new Promise(() => undefined);
}

async function withWatchdog<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: watchdog ${timeoutMs}ms exceeded`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function stalledBodyResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start() {
      // Intentionally never enqueue or close. runBeforeDeadline is the body-read backstop.
    },
  }), { status: 200 });
}

function kstToday(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1_000);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, "0")}${String(kst.getUTCDate()).padStart(2, "0")}`;
}

function registerBootstrapHtml(): string {
  return [
    '<input id="__VIEWSTATE" value="viewstate" />',
    '<input id="__VIEWSTATEGENERATOR" value="generator" />',
    '<input id="__EVENTVALIDATION" value="validation" />',
    `<input id="cphContents_cphContents_cphContents_hfSearchDate" value="${kstToday()}" />`,
  ].join("");
}

async function main() {
  const { rosterMovesRoute } = await import("../../src/app/api/cron/roster-moves/route");
  const snapshotSentinel = JSON.stringify({ snapshots: 10, moves: 4 });

  const cases = [
    { mode: "503", failAt: "get" },
    { mode: "204", failAt: "get" },
    { mode: "empty", failAt: "get" },
    { mode: "response-stall", failAt: "get" },
    { mode: "body-stall", failAt: "get" },
    { mode: "response-stall", failAt: "post" },
    { mode: "body-stall", failAt: "post" },
  ] as const;

  for (const { mode, failAt } of cases) {
    let dbFactoryCalls = 0;
    let scheduleCalls = 0;
    let fetchCalls = 0;
    let notifyCalls = 0;
    let sawAbortSignal = false;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls++;
      sawAbortSignal ||= init?.signal instanceof AbortSignal;
      if (failAt === "post" && fetchCalls === 1) {
        return new Response(registerBootstrapHtml(), { status: 200 });
      }
      if (mode === "response-stall") return neverResponse();
      if (mode === "body-stall") return stalledBodyResponse();
      if (mode === "empty") return new Response("", { status: 200 });
      return new Response(null, { status: Number(mode) });
    }) as typeof fetch;

    const startedAt = Date.now();
    const response = await withWatchdog(rosterMovesRoute(
      new NextRequest("http://localhost/api/cron/roster-moves?force=1", {
        headers: { authorization: "Bearer roster-deadline-smoke" },
      }),
      {
        now: () => new Date(),
        fetchImpl,
        fetchGamesImpl: async () => {
          scheduleCalls++;
          return [];
        },
        getSupabaseAdminImpl: (() => {
          dbFactoryCalls++;
          throw new Error("DB must not be initialized during collect failure");
        }) as never,
        notifyCollectionFailureImpl: async () => {
          notifyCalls++;
          return new Promise(() => undefined);
        },
        collectionDeadlineMs: 80,
      },
    ), 700, `${failAt}-${mode}`);
    const elapsedMs = Date.now() - startedAt;
    const payload = await response.json() as { ok: boolean; stage: string; error: string };

    const label = `${failAt}-${mode}`;
    assert.equal(response.status, 502, `${label}: status`);
    assert.equal(payload.ok, false, `${label}: ok`);
    assert.equal(payload.stage, "collect", `${label}: stage`);
    assert.equal(dbFactoryCalls, 0, `${label}: DB read/write/RPC 0`);
    assert.equal(scheduleCalls, 0, `${label}: force path skips schedule`);
    assert.equal(fetchCalls, failAt === "post" ? 2 : 1, `${label}: stop at first failed request`);
    assert.equal(notifyCalls, 1, `${label}: failure notification dispatched without blocking`);
    assert.equal(sawAbortSignal, true, `${label}: fetch receives abort signal`);
    assert.ok(elapsedMs < 500, `${label}: elapsed ${elapsedMs}ms exceeds budget`);
    assert.equal(JSON.stringify({ snapshots: 10, moves: 4 }), snapshotSentinel, `${label}: state unchanged`);
  }

  // Non-force cron: schedule discovery shares the same route deadline and
  // cannot reach collection or DB when its upstream never settles.
  {
    let dbFactoryCalls = 0;
    let collectionCalls = 0;
    const startedAt = Date.now();
    const response = await withWatchdog(rosterMovesRoute(
      new NextRequest("http://localhost/api/cron/roster-moves", {
        headers: { authorization: "Bearer roster-deadline-smoke" },
      }),
      {
        now: () => new Date(),
        fetchGamesImpl: async () => neverResponse() as never,
        fetchRegisterRostersImpl: async () => {
          collectionCalls++;
          throw new Error("collection must not start after schedule stall");
        },
        getSupabaseAdminImpl: (() => {
          dbFactoryCalls++;
          throw new Error("DB must not initialize after schedule stall");
        }) as never,
        collectionDeadlineMs: 80,
      },
    ), 700, "schedule-response-stall");
    const payload = await response.json() as { ok: boolean; stage: string };
    assert.equal(response.status, 502, "schedule stall status");
    assert.equal(payload.stage, "schedule", "schedule stall stage");
    assert.equal(dbFactoryCalls, 0, "schedule stall DB read/write/RPC 0");
    assert.equal(collectionCalls, 0, "schedule stall collection 0");
    assert.ok(Date.now() - startedAt < 500, "schedule stall bounded");
  }

  // Pending readiness: all three asset probes are covered by the route
  // deadline before the first mutating RPC, preserving stored state on stall.
  {
    let dbReadCalls = 0;
    let rpcCalls = 0;
    let updateCalls = 0;
    let probeCalls = 0;
    const probeSignals: AbortSignal[] = [];
    const pendingRows = [{
      id: "pending-1",
      team_id: 1,
      kbo_player_id: "51516",
      player_name: "테스트",
      move_date: "2026-08-01",
    }];
    const pendingBuilder = {
      select() { return this; },
      eq() { return this; },
      order() {
        return this;
      },
      limit() {
        dbReadCalls++;
        return Promise.resolve({ data: pendingRows, error: null });
      },
      update() {
        updateCalls++;
        return this;
      },
    };
    const admin = {
      from(table: string) {
        assert.equal(table, "roster_moves");
        return pendingBuilder;
      },
      rpc() {
        rpcCalls++;
        return Promise.resolve({ data: null, error: null });
      },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      probeCalls++;
      if (init?.signal instanceof AbortSignal) probeSignals.push(init.signal);
      return neverResponse();
    }) as typeof fetch;
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await withWatchdog(rosterMovesRoute(
        new NextRequest("http://localhost/api/cron/roster-moves?force=1", {
          headers: { authorization: "Bearer roster-deadline-smoke" },
        }),
        {
          now: () => new Date(),
          fetchRegisterRostersImpl: async () => ({ date: kstToday(), teams: [] }),
          getSupabaseAdminImpl: (() => admin) as never,
          collectionDeadlineMs: 80,
        },
      ), 700, "pending-readiness-stall");
    } finally {
      globalThis.fetch = realFetch;
    }
    const payload = await response.json() as { ok: boolean; stage: string };
    assert.equal(response.status, 502, "readiness stall status");
    assert.equal(payload.stage, "readiness", "readiness stall stage");
    assert.equal(dbReadCalls, 1, "readiness preflight reads pending once");
    assert.equal(probeCalls, 3, "profile/hero/player-card probes all started");
    assert.equal(probeSignals.length, 3, "each readiness fetch receives abort signal");
    assert.equal(rpcCalls, 0, "readiness stall RPC 0");
    assert.equal(updateCalls, 0, "readiness stall writes 0");
    assert.ok(Date.now() - startedAt < 500, "readiness stall bounded");
    assert.equal(JSON.stringify({ snapshots: 10, moves: 4 }), snapshotSentinel, "readiness state unchanged");
  }

  console.log(`roster-moves-deadline-smoke: ${cases.length + 2}/${cases.length + 2} PASS`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
