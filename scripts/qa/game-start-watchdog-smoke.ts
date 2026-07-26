import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runGameStartWatchdog } from "../../src/lib/notifications/game-start-watchdog";
import type { KboRawGame } from "../../src/types/api";

const game = (id: string, state: "1" | "2"): KboRawGame => ({
  G_ID: id,
  GAME_STATE_SC: state,
  CANCEL_SC_ID: "0",
} as KboRawGame);

async function main() {
  const games = [
    game("20260727LGTW0", "1"),
    game("20260727OBHH0", "2"),
    game("20260727KTSK0", "2"),
  ];
  const evidenceCalls: string[][] = [];
  const notifyCalls: KboRawGame[][] = [];
  const result = await runGameStartWatchdog({
    fetchGames: async () => ({ ok: true, games, observedAtMs: 1234 }),
    readStartStates: async () => [
      { game_id: "20260727OBHH0", start_notified: true, start_snapshot_at: "2026-07-27T09:00:00Z" },
    ],
    fetchStartEvidence: async (ids) => {
      evidenceCalls.push(ids);
      return new Map(ids.map((id) => [id, {
        completedPlateAppearances: 0,
        currentBatterIsLeadoff: true,
      }]));
    },
    notifyStartTransitions: async (selected, params) => {
      notifyCalls.push(selected);
      assert.equal(params.observedAtMs, 1234);
      assert.equal(params.startPlateAppearanceByGame.size, 1);
      return { started: 7 };
    },
    isCancelled: () => false,
  }, 9999);

  assert.deepEqual(evidenceCalls, [["20260727KTSK0"]]);
  assert.equal(notifyCalls[0].length, 3);
  assert.deepEqual(result, {
    scheduled: 1,
    live: 2,
    evidenceRequested: 1,
    started: 7,
  });

  await assert.rejects(
    () => runGameStartWatchdog({
      fetchGames: async () => ({ ok: false, games: [], observedAtMs: 0 }),
      readStartStates: async () => [],
      fetchStartEvidence: async () => new Map(),
      notifyStartTransitions: async () => ({ started: 0 }),
      isCancelled: () => false,
    }, 9999),
    /kbo_fetch_failed/,
  );

  const sql = readFileSync(
    "supabase/migrations/20260727_game_start_external_watchdog.sql",
    "utf8",
  ).toLowerCase();
  assert.match(sql, /cron\.schedule\(\s*'game-start-watchdog-15s'\s*,\s*'15 seconds'/s);
  assert.match(sql, /private\.game_start_watchdog_config/);
  assert.match(sql, /enabled boolean not null default false/);
  assert.match(sql, /authorization[\s\S]*bearer/);
  assert.doesNotMatch(sql, /bearer\s+[a-z0-9_-]{16,}/);
  assert.match(sql, /revoke all on function private\.invoke_game_start_watchdog/);

  console.log("game-start-watchdog: 10/10 PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
