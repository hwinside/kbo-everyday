import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deliverTokenChunks } from "../../src/lib/notifications/fcm-batch";
import {
  drainGameStartDeliveryBatches,
  gameStartDeliveryWindow,
} from "../../src/lib/notifications/game-start-delivery-policy";
import {
  mapHighlightSettlements,
  shouldProcessHighlightEvent,
} from "../../src/lib/notifications/player-highlight-delivery";

const migration = readFileSync(
  "supabase/migrations/20260726_game_start_device_delivery.sql",
  "utf8",
).toLowerCase();
const source = readFileSync("src/lib/notifications/game-start-delivery.ts", "utf8");
const gameStatusSource = readFileSync("src/lib/notifications/game-status.ts", "utf8");
const highlightSource = readFileSync("src/lib/notifications/player-highlight.ts", "utf8");

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
  assert.match(migration, /p_lease_seconds integer default 45/);
  assert.match(migration, /lease_until = now\(\) \+ make_interval/);
  assert.match(migration, /l\.status in \('pending', 'transient'\)/);
  assert.match(migration, /l\.attempts < 2/);
  assert.match(migration, /case l\.status when 'pending' then 0 when 'transient' then 1 else 2 end/);
  assert.match(migration, /l\.deadline_at > now\(\)/);
  assert.match(migration, /l\.next_attempt_at <= now\(\)/);
  assert.match(migration, /now\(\) \+ interval '45 seconds'/);
  assert.match(migration, /settle_game_start_delivery_batch/);
  assert.match(migration, /dispatch_started_at timestamptz/);
  assert.match(migration, /mark_game_start_deliveries_dispatching/);
  assert.match(migration, /l\.dispatch_started_at is null/);
  assert.match(source, /mark_game_start_deliveries_dispatching/);
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

test("bounded transport lease는 overlap을 막고 pre-dispatch crash는 deadline 전 재claim", async () => {
  let status: "pending" | "leased" | "accepted" = "pending";
  let leaseUntil = 0;
  let nowMs = 0;
  let sends = 0;
  const claim = async () => {
    if (status === "pending" || (status === "leased" && leaseUntil < nowMs)) {
      status = "leased";
      leaseUntil = nowMs + 45_000;
      return [{ id: "token-1" }];
    }
    return [];
  };
  const workerA = await claim();
  sends += workerA.length;
  nowMs = 8_000;
  status = "accepted";
  nowMs = 10_000;
  const workerB = await claim();
  assert.equal(workerB.length, 0, "transport 종료 전후 overlap은 terminal 행을 재claim할 수 없다");
  assert.equal(sends, 1);

  status = "pending";
  nowMs = 0;
  await claim(); // claim 직후 worker crash: send 0, settle 0
  nowMs = 10_000;
  assert.equal((await claim()).length, 0, "lease 안에서는 crash 행도 overlap claim 불가");
  nowMs = 46_000;
  assert.equal((await claim()).length, 1, "45초 lease 만료 뒤 90초 deadline 전 재claim");
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

test("highlight token barrier: ON+accepted/OFF만 release, pending·invalid는 다른 token을 막지 않는다", () => {
  const fixtures = [
    { token: "accepted", gameStart: true, startStatus: "accepted", release: true },
    { token: "pending", gameStart: true, startStatus: "transient", release: false },
    { token: "off", gameStart: false, startStatus: null, release: true },
    { token: "invalid", gameStart: true, startStatus: "permanent_failed", release: false },
    { token: "mark-only", gameStart: true, startStatus: null, release: false },
  ] as const;
  const released = fixtures
    .filter((row) => !row.gameStart || row.startStatus === "accepted")
    .map((row) => row.token);
  assert.deepEqual(released, ["accepted", "off"]);
  assert.match(migration, /claim_player_highlight_tokens/);
  assert.match(migration, /not n\.start_required/);
  assert.match(migration, /l\.status\s*=\s*'accepted'/);
  assert.match(migration, /l\.fcm_accepted_at\s*<\s*p_start_accepted_before/);
  assert.match(migration, /insert into notified_score_events/);
  assert.match(migration, /exists\s*\(\s*select 1 from notified_score_events/);
  assert.match(migration, /n\.status in \('waiting', 'transient'\)/);
  assert.match(migration, /n\.status = 'leased' and n\.lease_until < now\(\)/);
  assert.match(migration, /settle_player_highlight_tokens/);
  assert.match(migration, /now\(\) \+ interval '45 seconds'/);
  assert.match(highlightSource, /settle_player_highlight_tokens/);
  assert.match(highlightSource, /mapHighlightSettlements/);
  assert.match(migration, /limit greatest\(1,\s*least\(p_limit,\s*500\)\)/);
  assert.doesNotMatch(gameStatusSource, /highlightBlockedGameIds/);
});

test("highlight FCM ok=true 안의 token별 transient/permanent를 terminal 성공으로 오인하지 않는다", () => {
  const settled = mapHighlightSettlements(
    [
      { tokenId: 1, tokenHash: "h1", fcmToken: "ok" },
      { tokenId: 2, tokenHash: "h2", fcmToken: "retry" },
      { tokenId: 3, tokenHash: "h3", fcmToken: "bad" },
      { tokenId: 4, tokenHash: "h4", fcmToken: "unattempted" },
    ],
    [
      { token: "ok", status: "accepted", errorCode: null },
      { token: "retry", status: "transient", errorCode: "messaging/server-unavailable" },
      { token: "bad", status: "permanent_failed", errorCode: "messaging/sender-id-mismatch" },
    ],
    "deadline_exceeded",
  );
  assert.deepEqual(
    settled.map((row) => row.status),
    ["accepted", "transient", "permanent_failed", "transient"],
  );
});

test("highlight 10분 freshness는 신규 snapshot만 차단하고 frozen retry는 11분 gap 뒤에도 drain", () => {
  const nowMs = 1_000_000;
  const oldEventAtMs = nowMs - 11 * 60_000;
  assert.equal(shouldProcessHighlightEvent({
    eventAtMs: oldEventAtMs,
    nowMs,
    freshnessMs: 10 * 60_000,
    hasFrozenSnapshot: false,
  }), false);
  assert.equal(shouldProcessHighlightEvent({
    eventAtMs: oldEventAtMs,
    nowMs,
    freshnessMs: 10 * 60_000,
    hasFrozenSnapshot: true,
  }), true);
  assert.doesNotMatch(
    highlightSource,
    /if\s*\(userIds\.length === 0\)\s*\{[\s\S]{0,160}continue/,
    "현재 팬 0명이어도 frozen snapshot claim 결과를 send/settle해야 함",
  );
});
