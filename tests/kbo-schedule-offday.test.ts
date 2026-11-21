import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://schedule.test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-only";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
process.env.CRON_SECRET = "schedule-test-only";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/kbo-offday/${name}.json`, import.meta.url), "utf8"));

test("common schedule confirms recorded off day without Naver; failures remain failures", async () => {
  const { fetchGames } = await import("../src/lib/crawler/kbo-api");
  const original = globalThis.fetch;
  try {
    for (const mode of ["offday", "http", "error-code", "partial", "calendar-error", "gameday", "targeted"] as const) {
      let calendars = 0;
      let naver = 0;
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.includes("GetKboGameList")) {
          if (mode === "http") return new Response(null, { status: 503 });
          if (mode === "error-code") return Response.json({ ...fixture("empty-list"), code: "500" });
          if (mode === "partial") return Response.json({ code: "100", game: [{}] });
          return Response.json(fixture("empty-list"));
        }
        if (url.includes("GetKboGameDate")) {
          calendars++;
          assert.ok(init?.signal);
          if (mode === "calendar-error") return new Response(null, { status: 503 });
          return Response.json(fixture(mode === "gameday" ? "gameday-calendar" : "offday-calendar"));
        }
        if (url.includes("naver.com")) { naver++; throw new Error("Naver blocked"); }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;
      const request = fetchGames("20261028", mode === "targeted" ? "0" : undefined, { deadlineAtMs: Date.now() + 1500 });
      if (mode === "offday") {
        assert.deepEqual(await request, []);
        assert.equal(calendars, 1);
        assert.equal(naver, 0);
      } else {
        await assert.rejects(request, { name: "Error" }, mode);
        if (["http", "error-code", "partial", "targeted"].includes(mode)) assert.equal(calendars, 0, mode);
      }
    }
  } finally { globalThis.fetch = original; }
});

test("roster pregame tick skips confirmed off day without collection or DB writes", async () => {
  const { rosterMovesRoute } = await import("../src/app/api/cron/roster-moves/route");
  const { fetchGames } = await import("../src/lib/crawler/kbo-api");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async input => {
      const url = String(input);
      if (url.includes("GetKboGameList")) return Response.json(fixture("empty-list"));
      if (url.includes("GetKboGameDate")) return Response.json(fixture("offday-calendar"));
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const forbidden = (): never => { throw new Error("offday must not collect, write or notify"); };
    const response = await rosterMovesRoute(new NextRequest("https://schedule.test/api/cron/roster-moves", {
      headers: { authorization: "Bearer schedule-test-only" },
    }), {
      now: () => new Date("2026-10-28T02:00:00Z"),
      fetchGamesImpl: (_date, series, opts) => fetchGames("20261028", series, opts),
      fetchRegisterRostersImpl: forbidden, getSupabaseAdminImpl: forbidden,
      notifyCollectionFailureImpl: forbidden, notifyPendingMovesImpl: forbidden,
      checkPublishReadinessImpl: forbidden,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, skipped: true, run: false, reason: "no-games" });
  } finally { globalThis.fetch = original; }
});
