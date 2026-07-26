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
  // 주석(-- ...)을 벗겨 실행 SQL만 검사 — 헤더가 statement_timeout 불가 사유를 설명하므로.
  const migrationCode = migration.replace(/--.*$/gm, "");
  check("already-marked rows are fenced", (migration.match(/channel_born_channel_id is null/g) ?? []).length >= 2);
  check("rotating channels are skipped, not waited on", /for share skip locked/i.test(migration));
  check("partially locked environment sets exclude the whole game", /acquired\.generation_count = expected\.generation_count/i.test(migrationCode));
  check("target rows are locked with skip-locked to avoid stalls", /for update of s skip locked/i.test(migration));
  // 잠금을 batch LIMIT '이전'에 적용 — 잠긴 prefix로 배치가 막혀 뒤 unlocked 행이 starve되는 회귀 차단(R2).
  check("target lock (skip-locked) is applied before the batch LIMIT", /for update of s skip locked\s+limit \(v_limit \+ 1\)/i.test(migrationCode));
  check("no self-armed statement_timeout call (cannot bound outer stmt)", !/set_config\(\s*'statement_timeout'|set\s+statement_timeout/i.test(migrationCode));
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
