import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deliverTokenChunks } from "../../src/lib/notifications/fcm-batch";

const migration = readFileSync(
  "supabase/migrations/20260726_game_start_device_delivery.sql",
  "utf8",
).toLowerCase();
const source = readFileSync("src/lib/notifications/game-start-delivery.ts", "utf8");

test("최초 snapshot 고정 + 신규/교체 토큰 catch-up 금지", () => {
  assert.match(migration, /start_snapshot_at is null/);
  assert.match(migration, /if not v_created then\s+return false/);
  assert.match(
    migration,
    /unique\s*\(game_id,\s*event_type,\s*token_id,\s*token_hash\)/,
  );
  assert.match(migration, /extensions\.digest\(d\.fcm_token,\s*'sha256'\)/);
});

test("lease fencing + transient-only deadline retry", () => {
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /lease_token = p_lease_token/);
  assert.match(migration, /l\.status in \('pending', 'transient'\)/);
  assert.match(migration, /l\.deadline_at > now\(\)/);
  assert.match(migration, /status in \('pending', 'leased', 'transient'\)/);
  assert.match(migration, /status = 'expired'/);
});

test("snapshot 전량 terminal 이전 global 종결 금지", () => {
  assert.match(migration, /counts\.pending from counts\) = 0/);
  assert.match(
    migration,
    /update game_notify_state[\s\S]*set start_notified = true[\s\S]*counts\.pending from counts\) = 0/,
  );
});

test("Android TTL/collapse + APNs expiration/collapse 배선", () => {
  assert.match(source, /collapseKey:\s*`game_start_\$\{args\.gameId\}`/);
  assert.match(source, /ttlSeconds:\s*Math\.min\(90,\s*remainingSeconds\)/);
  assert.match(source, /apnsCollapseId:\s*`game-start-\$\{args\.gameId\}`/);
  assert.match(source, /apnsExpirationSeconds:\s*Math\.min\(90,\s*remainingSeconds\)/);
});

test("FCM 접수와 device 실도달 지표를 분리", () => {
  assert.match(migration, /fcm_accepted_at timestamptz/);
  assert.match(migration, /device_delivered_at timestamptz/);
  assert.match(source, /fcmAccepted:/);
  assert.match(source, /deviceDelivered:/);
  assert.doesNotMatch(source, /deviceDelivered:\s*Number\(row\.accepted/);
});

test("FCM token별 accepted/transient/permanent 결과를 원장에 매핑할 수 있다", async () => {
  const result = await deliverTokenChunks(["ok", "retry", "bad"], async () => ({
    successCount: 1,
    failureCount: 2,
    responses: [
      {},
      { error: { code: "messaging/server-unavailable" } },
      { error: { code: "messaging/sender-id-mismatch" } },
    ],
  }));
  assert.deepEqual(
    result.outcomes.map(({ token, status }) => ({ token, status })),
    [
      { token: "ok", status: "accepted" },
      { token: "retry", status: "transient" },
      { token: "bad", status: "permanent_failed" },
    ],
  );
});
