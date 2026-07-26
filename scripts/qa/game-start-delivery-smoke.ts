import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deliverTokenChunks } from "../../src/lib/notifications/fcm-batch";
import {
  drainGameStartDeliveryBatches,
  gameStartDeliveryWindow,
} from "../../src/lib/notifications/game-start-delivery-policy";

const migration = readFileSync(
  "supabase/migrations/20260726_game_start_device_delivery.sql",
  "utf8",
).toLowerCase();
const source = readFileSync("src/lib/notifications/game-start-delivery.ts", "utf8");

test("최초 snapshot 고정 + 신규/교체 토큰 catch-up 금지", () => {
  assert.match(migration, /start_snapshot_at is null/);
  assert.match(migration, /if not v_created then[\s\S]*return v_deadline/);
  assert.match(
    migration,
    /unique\s*\(game_id,\s*event_type,\s*token_id,\s*token_hash\)/,
  );
  assert.match(migration, /extensions\.digest\(d\.fcm_token,\s*'sha256'\)/);
});

test("lease fencing + transient-only deadline retry", () => {
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /lease_token = p_lease_token/);
  assert.match(migration, /lease_until = l\.deadline_at \+ interval '15 seconds'/);
  assert.match(migration, /l\.status in \('pending', 'transient'\)/);
  assert.match(migration, /l\.attempts < 2/);
  assert.match(migration, /case l\.status when 'pending' then 0 when 'transient' then 1 else 2 end/);
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
  assert.match(source, /ttlSeconds:\s*window\.ttlSeconds/);
  assert.match(source, /apnsCollapseId:\s*`game-start-\$\{args\.gameId\}`/);
  assert.match(source, /apnsExpirationSeconds:\s*window\.apnsExpirationSeconds/);
});

test("FCM 접수와 device 실도달 지표를 분리", () => {
  assert.match(migration, /fcm_accepted_at timestamptz/);
  assert.match(migration, /device_delivered_at timestamptz/);
  assert.match(source, /fcmAcceptedDelta:/);
  assert.match(source, /fcmAcceptedTotal:/);
  assert.match(source, /deviceDelivered:/);
  assert.match(source, /deviceDelivered:\s*row\.device_delivered == null \? null/);
  assert.match(migration, /null::bigint as device_delivered/);
});

test("운영규모 3,500행 + 첫 500 transient에서도 pending 전량을 먼저 drain", async () => {
  type Row = { id: number; status: "pending" | "transient" | "accepted"; attempts: number };
  const rows: Row[] = Array.from({ length: 3_500 }, (_, id) => ({ id, status: "pending", attempts: 0 }));
  const attempted: number[] = [];
  const acceptedDelta = await drainGameStartDeliveryBatches({
    deadlineAtMs: 90_000,
    now: () => 0,
    claim: async () => rows
      .filter((row) => row.status === "pending" || row.status === "transient")
      .sort((a, b) => Number(a.status !== "pending") - Number(b.status !== "pending") || a.id - b.id)
      .slice(0, 500),
    process: async (claimed) => {
      attempted.push(...claimed.map((row) => row.id));
      for (const row of claimed) {
        row.attempts += 1;
        row.status = row.id < 500 && row.attempts === 1 ? "transient" : "accepted";
      }
      return claimed.filter((row) => row.status === "accepted").length;
    },
  });
  assert.equal(new Set(attempted.slice(0, 3_500)).size, 3_500);
  assert.deepEqual(attempted.slice(3_500, 4_000), Array.from({ length: 500 }, (_, id) => id));
  assert.ok(rows.every((row) => row.status === "accepted"));
  assert.equal(acceptedDelta, 3_500, "accepted delta는 각 행의 terminal 전이를 한 번만 합산");
});

test("T+60 retry도 최초 persisted deadline T+90을 단일 시계로 사용", () => {
  const window = gameStartDeliveryWindow(90_000, 60_000);
  assert.deepEqual(window, {
    deadlineAtMs: 90_000,
    ttlSeconds: 30,
    apnsExpirationSeconds: 30,
  });
  assert.equal(gameStartDeliveryWindow(90_000, 90_000), null);
  assert.deepEqual(
    gameStartDeliveryWindow(90_000, 0, 52_000),
    { deadlineAtMs: 52_000, ttlSeconds: 90, apnsExpirationSeconds: 90 },
    "transport는 route budget으로 자르되 TTL/APNs는 최초 snapshot deadline을 유지",
  );
});

test("slow worker의 T+20 중첩 claim은 lease가 T+105까지 살아 FCM send 1회", async () => {
  let status: "pending" | "leased" | "accepted" = "pending";
  let leaseUntil = 0;
  let nowMs = 0;
  let sends = 0;
  const claim = async () => {
    if (status === "pending" || (status === "leased" && leaseUntil < nowMs)) {
      status = "leased";
      leaseUntil = 105_000;
      return [{ id: "token-1" }];
    }
    return [];
  };
  const workerA = await claim();
  nowMs = 20_000;
  const workerB = await claim();
  assert.equal(workerB.length, 0, "20초 중첩 worker는 lease 중인 행을 claim할 수 없다");
  sends += workerA.length;
  status = "accepted";
  assert.equal(sends, 1);
});

test("accepted는 invocation delta와 snapshot 누계를 분리하고 device 도달은 unknown", () => {
  assert.match(source, /fcmAcceptedDelta/);
  assert.match(source, /fcmAcceptedTotal/);
  assert.match(source, /deviceDelivered:\s*number \| null/);
  assert.doesNotMatch(source, /fcmAccepted:\s*Number\(row\.accepted/);
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
