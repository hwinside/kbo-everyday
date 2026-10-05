import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";

// Execute the actual route, replacing only I/O boundaries. No production imports,
// network, DB writes, or real credentials; unexpected imports fail closed.
const source = readFileSync("src/app/api/cron/game-logs/route.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function check(incompleteCount: number, gamesFailed = 0, dateFailed = false) {
  const calls: unknown[][] = [];
  const fixtures = [
    { gameId: "complete", status: "complete", rowsUpserted: 1, unresolved: [] },
    ...Array.from({ length: incompleteCount }, (_, i) => ({
      gameId: `incomplete-${i}`, status: "incomplete", rowsUpserted: 0,
      unresolved: [], failureReason: "unresolved_player",
    })),
    ...Array.from({ length: gamesFailed }, () => ({ gameId: "throws" })),
  ];
  const failedDates = dateFailed ? [{ date: "20261002", error: "fixture fetch failure" }] : [];
  const mocks: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@/lib/supabase/admin": { supabaseAdmin: {} },
    "@/lib/admin/job-logger": {
      startJob: async () => "fixture-job",
      finishJob: async (...args: unknown[]) => { calls.push(args); },
    },
    "@/lib/crawler/kbo-api": { fetchGames: async () => { throw new Error("unexpected fetch"); } },
    "@/lib/game-logs/collect-dates": { collectFinalGamesByDate: async () => ({ finals: fixtures, failedDates }) },
    "@/lib/game-logs/ledger-ingest": {
      ingestGameWithLedger: async (_client: unknown, game: { gameId: string }) => {
        if (game.gameId === "throws") throw new Error("fixture ingestion failure");
        return game;
      },
    },
    "@/lib/game-logs/roster-gap-alert": { notifyRosterGaps: async () => ({ gaps: [], status: "no-webhook" }) },
    "@/lib/utils/date-kst": { getKSTToday: () => "2026-10-03", getKSTYesterday: () => "2026-10-02" },
  };
  const route = { exports: {} as { GET: (req: NextRequest) => Promise<Response> } };
  new Function("require", "module", "exports", "process", compiled)(
    (id: string) => {
      assert.ok(Object.hasOwn(mocks, id), `unexpected dependency: ${id}`);
      return mocks[id];
    }, route, route.exports, { env: { CRON_SECRET: "fixture-only" } },
  );
  const response = await route.exports.GET(new NextRequest("https://fixture.invalid/api/cron/game-logs", {
    headers: { authorization: "Bearer fixture-only" },
  }));
  const body = await response.json();
  const ok = incompleteCount === 0 && gamesFailed === 0 && !dateFailed;
  assert.equal(response.status, ok ? 200 : 500);
  assert.equal(body.ok, ok);
  assert.equal(body.incomplete.length, incompleteCount);
  assert.equal(body.complete, 1);
  assert.equal(body.gamesFailed, gamesFailed);
  assert.deepEqual(body.failedDates, failedDates);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "fixture-job");
  assert.equal(calls[0][1], ok ? "success" : "error");
  if (ok) assert.equal(calls[0][3], undefined);
  else assert.match(String(calls[0][3]), new RegExp(`incomplete: ${incompleteCount}`));
}

async function main() {
  await check(1); // Mixed complete + incomplete, even with no webhook -> error/500.
  await check(0); // No incomplete -> success/200, not an unconditional error.
  await check(0, 1);
  await check(0, 0, true);
  console.log("PASS game-logs-cron-route");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
