import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { isConfirmedKboOffday } from "../src/lib/crawler/kbo-offday";
import { runGameStartWatchdog } from "../src/lib/notifications/game-start-watchdog";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://offday.test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-only";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/kbo-offday/${name}.json`, import.meta.url), "utf8"));
const empty = fixture("empty-list");
const offday = fixture("offday-calendar");
const gameday = fixture("gameday-calendar");

test("recorded KBO calendar distinguishes the gap from adjacent game days", () => {
  assert.equal(isConfirmedKboOffday("20261028", offday), true);
  for (const date of ["20261027", "20261029", "20261030", "20260230", "bad"]) {
    assert.equal(isConfirmedKboOffday(date, offday), false, date);
  }
  for (const value of [null, {}, gameday, { ...offday, code: "500" },
    { ...offday, BEFORE_G_DT: "" }, { ...offday, NOW_G_DT: "20261028" },
    { ...offday, AFTER_G_DT: "20261029" }, { ...offday, BEFORE_G_DT: "20260230" }]) {
    assert.equal(isConfirmedKboOffday("20261028", value), false);
  }
});

test("actual live GET: recorded off day is 200 with zero Naver/self-fetch; durable conflicts still fail", async () => {
  const { GET } = await import("../src/app/api/game-live/route");
  const original = globalThis.fetch;
  try {
    for (const mode of ["empty", "conflict", "db-fail"] as const) {
      const calls: string[] = [];
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("GetKboGameList")) return Response.json(empty);
        if (url.includes("GetKboGameDate")) {
          const body = new URLSearchParams(String(init?.body));
          assert.equal(body.get("date"), "20261028");
          assert.equal(body.get("srId"), "0,1,3,4,5,7,8,9");
          assert.ok(init?.signal);
          return Response.json(offday);
        }
        if (url.includes("offday.test/rest/v1/game_notify_state")) {
          return Response.json(mode === "conflict" ? [{ game_id: "20261028HTSS0" }] : [], { status: mode === "db-fail" ? 503 : 200 });
        }
        throw new Error(`unrecorded network request: ${url}`);
      }) as typeof fetch;
      const res = await GET(new NextRequest("https://offday.test/api/game-live?date=20261028"));
      const body = await res.json();
      assert.equal(res.status, mode === "empty" ? 200 : 503, mode);
      assert.deepEqual(body.games, []);
      assert.match(res.headers.get("Cache-Control")!, /no-store/);
      assert.equal(body.trace.stage, mode === "empty" ? "kbo-offday-confirmed" : mode === "conflict" ? "known-slate-mismatch" : "starter-witness-failed");
      assert.equal(calls.length, 3, "only scoreboard, calendar and durable slate are allowed");
    }
  } finally { globalThis.fetch = original; }
});

test("watchdog consumes confirmed off day without reads, evidence or notification writes", async () => {
  const { fetchKboLiveGames } = await import("../src/lib/notifications/kbo-live-games");
  let naverCalls = 0;
  const upstream = (async input => Response.json(String(input).includes("GetKboGameDate") ? offday : empty)) as typeof fetch;
  const unexpected = async (): Promise<never> => { throw new Error("off day must not touch notification state"); };
  const result = await runGameStartWatchdog({
    fetchGames: async deadline => {
      const r = await fetchKboLiveGames("20261028", deadline, upstream, async () => { naverCalls++; throw new Error("Naver blocked"); });
      return { ...r, observedAtMs: r.trace.fetchedAtMs };
    },
    readStartStates: unexpected, fetchStartEvidence: unexpected,
    notifyStartTransitions: unexpected, isCancelled: () => false,
  }, Date.now() + 1000);
  assert.deepEqual(result, { scheduled: 0, live: 0, evidenceRequested: 0, started: 0 });
  assert.equal(naverCalls, 0);
});

test("failed/invalid KBO never becomes a successful off day; unknown calendar retains fail-close", async () => {
  const { fetchKboLiveGames } = await import("../src/lib/notifications/kbo-live-games");
  for (const mode of ["http", "network", "json", "schema", "calendar-http", "calendar-schema", "calendar-error-code", "calendar-gameday", "calendar-timeout", "error-code", "targeted"] as const) {
    let calendarCalls = 0;
    let naverCalls = 0;
    let settled = false;
    const upstream = (async (input, init) => {
      if (String(input).includes("GetKboGameDate")) {
        calendarCalls++;
        if (mode === "calendar-http") return new Response(null, { status: 503 });
        if (mode === "calendar-schema") return Response.json({});
        if (mode === "calendar-error-code") return Response.json({ ...offday, code: "500" });
        if (mode === "calendar-gameday") return Response.json(gameday);
        if (mode === "calendar-timeout") return await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => { settled = true; reject(init!.signal!.reason); }, { once: true });
        });
        return Response.json(offday);
      }
      if (mode === "http") return new Response(null, { status: 503 });
      if (mode === "network") throw new Error("KBO unavailable");
      if (mode === "json") return new Response("<html>error</html>");
      if (mode === "schema") return Response.json({ code: "100" });
      return Response.json(mode === "error-code" ? { ...empty, code: "500" } : empty);
    }) as typeof fetch;
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      const r = await fetchKboLiveGames("20261028", Date.now() + 300, upstream, async () => {
        naverCalls++; throw new Error("Naver blocked");
      }, undefined, mode === "targeted" ? "20261028HTSS0" : undefined);
      assert.equal(r.ok, false, mode);
      assert.equal(r.trace.stage, "dual-fail", mode);
      assert.equal(naverCalls, mode === "calendar-timeout" ? 0 : 1, mode);
      assert.equal(calendarCalls, mode.startsWith("calendar-") ? 1 : 0, mode);
      if (mode === "calendar-timeout") assert.equal(settled, true, "raw calendar I/O settled before return");
      await assert.rejects(runGameStartWatchdog({
        fetchGames: async () => ({ ...r, observedAtMs: r.trace.fetchedAtMs }),
        readStartStates: async () => [], fetchStartEvidence: async () => new Map(),
        notifyStartTransitions: async () => { throw new Error("must not notify"); }, isCancelled: () => false,
      }, Date.now() + 100), /kbo_fetch_failed/);
    } finally { clearTimeout(keepAlive); }
  }
});
