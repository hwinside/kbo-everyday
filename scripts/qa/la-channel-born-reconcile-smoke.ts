import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CHANNEL_BORN_RECONCILE_LIMIT,
  CHANNEL_BORN_RECONCILE_TIMEOUT_MS,
  reconcileChannelBornFromAcks,
} from "../../src/lib/notifications/live-activity-channel-born-reconcile";

let checks = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks += 1;
}

async function main() {
  let clock = 1_000;
  let seenLimit = 0;
  const success = await reconcileChannelBornFromAcks({
    limit: CHANNEL_BORN_RECONCILE_LIMIT + 500,
    now: () => clock,
    execute: async (limit, signal) => {
      seenLimit = limit;
      check("RPC receives a live abort signal", !signal.aborted);
      clock += 37;
      return {
        data: [{
          active_generations: 10,
          eligible: 1_000,
          healed: 1_000,
          has_more: true,
        }],
        error: null,
      };
    },
  });
  check("caller limit is capped", seenLimit === CHANNEL_BORN_RECONCILE_LIMIT);
  check("success metrics are preserved", success.ok && success.healed === 1_000);
  check("bounded continuation is explicit", success.hasMore);
  check("duration metric is measured", success.durationMs === 37);

  const failed = await reconcileChannelBornFromAcks({
    execute: async () => ({ data: null, error: { message: "db unavailable" } }),
  });
  check("RPC failure is a non-throwing fanout-safe result", !failed.ok);
  check("RPC failure keeps an alertable reason", failed.error === "db unavailable");
  check("wall-clock cap stays bounded", CHANNEL_BORN_RECONCILE_TIMEOUT_MS === 5_000);

  const migration = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260726_la_channel_born_reconcile.sql"),
    "utf8",
  );
  check("ACK must match active environment", /ack\.environment = a\.environment/.test(migration));
  check("ACK must match active channel id", /ack\.channel_id = a\.channel_id/.test(migration));
  check("only active generations participate", /c\.status = 'active'/.test(migration));
  check("already-marked rows are fenced twice", (migration.match(/s\.channel_born_channel_id is null/g) ?? []).length >= 2);
  check("channel rotation is serialized", /for share/i.test(migration));
  check("SQL statement has a wall-clock timeout", /statement_timeout', '5000'/.test(migration));
  check("pagination batch has a hard cap", /least\(greatest\(coalesce\(p_limit, 1000\), 1\), 1000\)/.test(migration));
  check("has_more reads one bounded lookahead row", /limit \(v_limit \+ 1\)/.test(migration));

  const warmup = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/cron/game-events-warmup/route.ts"),
    "utf8",
  );
  const fanoutAt = warmup.indexOf("const laOrchestration =");
  const launchedAt = warmup.indexOf("const channelBornReconcilePromise =");
  const awaitedAt = warmup.indexOf("channelBornReconcilePromise,", fanoutAt);
  check("reconcile cannot lock channels before LA critical fanout", launchedAt > fanoutAt);
  check("reconcile is chained after the critical promise", /laOrchestration\.criticalPromise\.then\(/.test(warmup));
  check("reconcile is only joined at final drain", awaitedAt > fanoutAt);
  check("reconcile failure returns alertable cron 5xx", /channelBornReconcile\.ok \? 200 : 500/.test(warmup));

  console.log(`la-channel-born-reconcile smoke: ${checks}/${checks} PASS`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
