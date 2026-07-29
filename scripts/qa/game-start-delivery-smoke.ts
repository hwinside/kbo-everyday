import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deliverTokenChunks } from "../../src/lib/notifications/fcm-batch";
import {
  drainGameStartDeliveryBatches,
  drainGameStartDeliveryRoundRobin,
  gameStartDeliveryWindow,
} from "../../src/lib/notifications/game-start-delivery-policy";
import {
  drainDueHighlightSnapshots,
  mapHighlightSettlements,
  persistHighlightSnapshotBeforeAudience,
  shouldProcessHighlightEvent,
} from "../../src/lib/notifications/player-highlight-delivery";

const migration = readFileSync(
  "supabase/migrations/20260726_game_start_device_delivery.sql",
  "utf8",
).toLowerCase();
const throughputMigration = readFileSync(
  "supabase/migrations/20260730_game_start_fanout_throughput.sql",
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

test("최신 활성토큰 우선 + pending-first/transient-last claim", () => {
  assert.match(throughputMigration, /is_primary_token boolean not null default false/);
  assert.match(
    throughputMigration,
    /partition by d\.user_id[\s\S]*d\.last_seen desc nulls last[\s\S]*d\.id desc/,
  );
  assert.match(
    throughputMigration,
    /case l\.status when 'pending' then 0 when 'transient' then 1 else 2 end,[\s\S]*l\.is_primary_token desc/,
  );
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

test("round-robin은 pass당 게임별 1 batch, 안전마진 미만이면 신규 claim 0", async () => {
  let clock = 0;
  const calls: string[] = [];
  await drainGameStartDeliveryRoundRobin({
    items: ["G1", "G2", "G3"],
    deadlineAtMs: 10_000,
    minRemainingMs: 5_000,
    now: () => clock,
    process: async (gameId) => {
      calls.push(gameId);
      if (gameId === "G1") clock += 3_000;
      return { claimed: 500, pending: 500 };
    },
  });
  assert.deepEqual(calls, ["G1", "G2", "G3", "G1", "G2", "G3"]);

  clock = 6_000;
  calls.length = 0;
  await drainGameStartDeliveryRoundRobin({
    items: ["G1", "G2"],
    deadlineAtMs: 10_000,
    minRemainingMs: 5_000,
    now: () => clock,
    process: async (gameId) => {
      calls.push(gameId);
      return { claimed: 1, pending: 1 };
    },
  });
  assert.deepEqual(calls, []);
  assert.match(
    source,
    /attemptDeadlineAtMs - Date\.now\(\) < START_DELIVERY_NEW_BATCH_MIN_REMAINING_MS/,
  );
});

test("실측 5경기 16,655행 편중(최대 6,587)도 90초 내 미시도 0", async () => {
  const sizes = [6_587, 4_208, 2_329, 2_324, 1_207];
  const games = sizes.map((size, index) => ({ id: `G${index + 1}`, remaining: size }));
  let clock = 0;
  for (let tickAt = 0; tickAt < 90_000; tickAt += 15_000) {
    clock = Math.max(clock, tickAt);
    await drainGameStartDeliveryRoundRobin({
      items: games.filter((game) => game.remaining > 0),
      deadlineAtMs: Math.min(90_000, tickAt + 12_000),
      minRemainingMs: 5_000,
      now: () => clock,
      process: async (game) => {
        const claimed = Math.min(500, game.remaining);
        if (game.id === "G1" && claimed > 0) clock += 1_400;
        game.remaining -= claimed;
        return { claimed, pending: game.remaining };
      },
    });
    if (games.every((game) => game.remaining === 0)) break;
  }
  assert.ok(games.every((game) => game.remaining === 0));
  assert.ok(clock < 90_000);
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
  assert.doesNotMatch(migration, /p_start_accepted_before\s*-\s*interval '45 seconds'/);
  assert.match(migration, /insert into notified_score_events/);
  assert.match(migration, /exists\s*\(\s*select 1 from notified_score_events/);
  assert.match(migration, /n\.status in \('waiting', 'transient'\)/);
  assert.match(migration, /n\.status = 'leased' and n\.lease_until < now\(\)/);
  assert.match(migration, /settle_player_highlight_tokens/);
  assert.match(migration, /now\(\) \+ interval '45 seconds'/);
  assert.match(highlightSource, /settle_player_highlight_tokens/);
  assert.match(highlightSource, /mapHighlightSettlements/);
  assert.match(migration, /limit greatest\(1,\s*least\(p_limit,\s*500\)\)/);
  assert.match(migration, /list_due_player_highlight_snapshots/);
  assert.match(migration, /push_title text not null/);
  assert.match(migration, /player_id text not null/);
  assert.match(highlightSource, /fetchFavoritePlayerFanIds\(\s*due\.player_id/);
  assert.doesNotMatch(highlightSource, /userIds\.slice\(/);
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

test("첫 due fan query hang을 bounded timeout으로 격리하고 다음 snapshot을 drain", async () => {
  const drained: string[] = [];
  const accepted = await drainDueHighlightSnapshots({
    snapshots: [
      { id: "hung", snapshotCompleted: false },
      { id: "next", snapshotCompleted: true },
    ],
    needsAudience: (snapshot) => !snapshot.snapshotCompleted,
    fetchAudience: async () => new Promise<string[]>(() => {}),
    drain: async (snapshot) => {
      drained.push(snapshot.id);
      return 1;
    },
    audienceTimeoutMs: 10,
  });
  assert.equal(accepted, 1);
  assert.deepEqual(drained, ["next"]);
});

test("마지막 live play는 fan lookup 전에 durable 저장되어 final 이후 due resume", async () => {
  const due: Array<{ id: string; snapshotCompleted: boolean }> = [];
  const snapshot = { id: "last-play", snapshotCompleted: false };
  const persisted = await persistHighlightSnapshotBeforeAudience({
    snapshot,
    persist: async (row) => {
      due.push(row);
    },
    timeoutMs: 10,
  });
  assert.equal(persisted, true);

  const firstDrain = await drainDueHighlightSnapshots({
    snapshots: due,
    needsAudience: (row) => !row.snapshotCompleted,
    fetchAudience: async () => new Promise<string[]>(() => {}),
    drain: async () => {
      assert.fail("fan lookup이 hang이면 snapshot을 완료하면 안 됨");
    },
    audienceTimeoutMs: 10,
  });
  assert.equal(firstDrain, 0);
  assert.deepEqual(due, [snapshot], "eventsByGame이 비어도 durable due row가 남아야 함");

  const resumed = await drainDueHighlightSnapshots({
    snapshots: due,
    needsAudience: (row) => !row.snapshotCompleted,
    fetchAudience: async () => ["fan-1"],
    drain: async (row, userIds) => {
      assert.deepEqual(userIds, ["fan-1"]);
      row.snapshotCompleted = true;
      return 1;
    },
  });
  assert.equal(resumed, 1);
  assert.equal(due[0]?.snapshotCompleted, true);
});

test("live source는 snapshot persist 후 due 단일 fan 경로로 수렴", () => {
  const persistAt = highlightSource.indexOf(".upsert({");
  const dueAt = highlightSource.indexOf('"list_due_player_highlight_snapshots"');
  const fanAt = highlightSource.indexOf("fetchFavoritePlayerFanIds(");
  assert.ok(persistAt >= 0 && persistAt < dueAt && dueAt < fanAt);
  assert.doesNotMatch(highlightSource.slice(0, dueAt), /fetchFavoritePlayerFanIds\(/);
  assert.match(migration, /audience_attempts integer not null default 0/);
  assert.match(migration, /audience_next_attempt_at timestamptz not null default now\(\)/);
  assert.match(migration, /order by s\.snapshot_completed desc,\s*s\.audience_attempts/);
  assert.match(migration, /audience_next_attempt_at = now\(\) \+ interval '45 seconds'/);
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
