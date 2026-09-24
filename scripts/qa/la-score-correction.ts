/** Independent QA: durable SQL state machine + real broadcast pass, no production writes. */
import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { runChannelBroadcastPass } from "../../src/lib/notifications/live-activity-channel-broadcast-pass";
import type { ChannelRow } from "../../src/lib/notifications/live-activity-channels";
import type { KboRawGame } from "../../src/types/api";
import type { ScoreGuardObservation } from "../../src/lib/notifications/live-activity-score-guard";

async function main() {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(readFileSync("supabase/migrations/20260924_live_activity_score_guard.sql", "utf8"));
  // Score-guard events must be accepted without relabelling as schema errors.
  await db.exec("create table public.api_fallback_events(reason text constraint api_fallback_events_reason_check check (reason in ('timeout','http-error','schema-error','network-error')));");
  await db.exec(readFileSync("supabase/migrations/20260924_live_activity_score_guard_alert_reason.sql", "utf8"));
  await db.exec("insert into public.api_fallback_events values ('score-guard');");
  await assert.rejects(db.exec("insert into public.api_fallback_events values ('unknown');"));
  // Execute the production alert registration body with missing Next request context.
  const guardSource = readFileSync("src/lib/notifications/live-activity-score-guard.ts", "utf8");
  const alertStart = guardSource.indexOf("function alert(");
  const alertEnd = guardSource.indexOf("export async function observe", alertStart);
  assert.ok(alertStart >= 0 && alertEnd > alertStart);
  const alertCode = ts.transpileModule(guardSource.slice(alertStart, alertEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let logged = 0;
  const makeAlert = new Function("after", "trackApiDegradation", "console", alertCode + "; return alert;");
  const noContextAlert = makeAlert(() => { throw new Error("no request context"); },
    () => { throw new Error("must not execute"); }, { error: () => { logged++; } });
  assert.doesNotThrow(() => noContextAlert("test-game", "test"));
  assert.equal(logged, 1, "registration failure visible but cannot abort APNs");
  let reason: string | undefined;
  const validAlert = makeAlert((cb: () => void) => cb(), (_name: string, label: string) => { reason = label; }, console);
  validAlert("test-game", "test");
  assert.equal(reason, "score-guard");
  const gameId = "20260924LTLG0";
  const baseline = "1|0|3|true|false|false|false|live";
  const start = Date.now() - 180_000;
  async function observe(offset: number, regressed = true, eligible = true, corroborated = false, candidate = "0|4") {
    const { rows } = await db.query<{ result: ScoreGuardObservation }>(
      "select public.observe_live_activity_score_guard($1,$2,$3,$4,$5,$6,$7) as result",
      [gameId, baseline, candidate, new Date(start + offset).toISOString(), regressed, eligible, corroborated]);
    return rows[0].result;
  }
  let guard = await observe(0);
  assert.equal(guard.allowCorrection, false);
  assert.equal(guard.blockedCount, 1);
  assert.equal((await observe(0)).blockedCount, 1, "same fetch reused by env/legacy must not count twice");
  assert.equal((await observe(15_000)).allowCorrection, false);
  guard = await observe(30_000);
  assert.equal(guard.allowCorrection, true, "3 fresh matching observations over 30 seconds release probation");
  assert.equal(guard.candidateCount, 3);
  assert.equal((await observe(10_000)).allowCorrection, false, "late older worker cannot inherit release");
  await observe(45_000, false, true, false, "1|0");
  guard = await observe(60_000, true, true, false, "0|0");
  assert.equal(guard.allowCorrection, false, "1:0 → 0:0 → 1:0 resets the episode");
  assert.equal(guard.candidateCount, 1);
  assert.equal((await observe(75_000, true, true, true)).allowCorrection, true, "schedule+relay agreement is immediate");
  await observe(90_000, false);
  for (const time of [100_000, 115_000, 130_000]) {
    guard = await observe(time, true, false);
    assert.equal(guard.allowCorrection, false, "stale fallback / inning retreat never times out into permission");
  }
  assert.equal(guard.blockedCount, 3, "persistent blocked count exposes the alert threshold");
  assert.equal(guard.blockedMs, 30_000);

  const now = Date.now();
  const row = { game_id: gameId, environment: "production", channel_id: "test-channel", status: "active",
    last_score_state: baseline, last_state_hash: "old", last_p10_at: new Date(now).toISOString(),
    last_send_at: new Date(now).toISOString(), last_content_state: { awayScore: 1, homeScore: 0 },
    attempt_count: 0, next_retry_at: null, created_at: new Date(now).toISOString(), ending_at: null } as ChannelRow;
  const game = { G_ID: gameId, GAME_STATE_SC: "2", CANCEL_SC_ID: "0" } as KboRawGame;
  const content = { awayScore: 0, homeScore: 4, inning: 3, isTopInning: false, status: "live",
    onFirst: false, onSecond: false, onThird: false };
  const sent: Array<Record<string, unknown>> = [];
  const patches: Array<Record<string, unknown>> = [];
  const deps = {
    now: () => now,
    gameStatus: () => "live" as const,
    buildContentState: () => content,
    observeScoreGuard: async () => guard,
    send: async (p: { contentState: Record<string, unknown>; priority: string }) => {
      assert.equal(p.priority, "10"); sent.push(p.contentState); return { ok: true };
    },
    deleteChannel: async () => true,
    updateChannel: async (_row: ChannelRow, patch: Record<string, unknown>) => { patches.push(patch); return 1; },
  };
  const blocked = await runChannelBroadcastPass([row], [game], undefined, {}, deps);
  assert.equal(sent.length, 0);
  assert.deepEqual(blocked.failedGameIds, [gameId], "guard blockage must re-arm no-diff sub-tick");
  assert.equal(blocked.scoreGuards?.[0].blockedCount, 3);
  guard = { allowCorrection: true, blockedCount: 3, blockedMs: 30_000 };
  const corrected = await runChannelBroadcastPass([row], [game], undefined, {}, deps);
  assert.equal(corrected.updates, 1);
  assert.equal(sent[0].awayScore, 0);
  assert.equal(sent[0].homeScore, 4);
  assert.equal(patches[0].last_score_state, "0|4|3|false|false|false|false|live");
  assert.equal(row.last_content_state?.awayScore, 1, "old heartbeat material is not mutated in place");
  await db.close();
  console.log("la-score-correction: SQL persistence/dedup/reset/release + actual broadcast payload PASS");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
