import assert from "node:assert/strict";
import { normalizeManualPushTargets, reconcileDeliveryLedger } from "../../src/lib/admin/delivery-ledger";
import { deliverTokenChunks } from "../../src/lib/notifications/fcm-batch";

const exactCases = [999, 1000, 1001, 2001];
for (const count of exactCases) {
  const result = reconcileDeliveryLedger({
    expected: count,
    selected: count,
    tokens: count,
    sent: count,
    failed: 0,
    infrastructureOk: true,
  });
  assert.equal(result.status, "completed");
}

const multiDevice = reconcileDeliveryLedger({
  expected: 1001,
  selected: 1001,
  tokens: 1200,
  sent: 1197,
  failed: 3,
  infrastructureOk: true,
});
assert.equal(multiDevice.status, "completed_with_failures");

assert.throws(
  () => reconcileDeliveryLedger({
    expected: 1001,
    selected: 1000,
    tokens: 1000,
    sent: 1000,
    failed: 0,
    infrastructureOk: true,
  }),
  /target mismatch/,
);

assert.throws(
  () => reconcileDeliveryLedger({
    expected: 2001,
    selected: 2001,
    tokens: 2001,
    sent: 1999,
    failed: 1,
    infrastructureOk: true,
  }),
  /delivery mismatch/,
);

const infraFailure = reconcileDeliveryLedger({
  expected: 1000,
  selected: 1000,
  tokens: 0,
  sent: 0,
  failed: 0,
  infrastructureOk: false,
});
assert.equal(infraFailure.status, "completed_with_failures");
assert.equal(infraFailure.lastError, "fcm_infrastructure_failure");

assert.equal(normalizeManualPushTargets(undefined, false), null);
assert.deepEqual(
  normalizeManualPushTargets([
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000001",
  ], true),
  ["00000000-0000-4000-8000-000000000001"],
);
assert.throws(() => normalizeManualPushTargets([123], true), /UUID strings/);
assert.throws(() => normalizeManualPushTargets([], true), /non-empty UUID array/);

async function main() {
  const fixtureTokens = Array.from({ length: 1001 }, (_, index) => `token-${index}`);
  let chunk = 0;
  const partial = await deliverTokenChunks(fixtureTokens, async (items) => {
    chunk += 1;
    if (chunk === 2) throw new Error("page-2 FCM fault");
    return { successCount: items.length, failureCount: 0, responses: items.map(() => ({})) };
  });
  assert.deepEqual(
    { tokens: partial.tokens, sent: partial.sent, failed: partial.failed, ok: partial.ok },
    { tokens: 1001, sent: 501, failed: 500, ok: false },
  );
  assert.equal(partial.lastError, "page-2 FCM fault");

  console.log("admin delivery ledger smoke: PASS (target fail-closed + partial FCM ledger)");
}

void main();
