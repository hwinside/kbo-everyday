import assert from "node:assert/strict";
import { reconcileDeliveryLedger } from "../../src/lib/admin/delivery-ledger";

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

console.log("admin delivery ledger smoke: PASS (7 cases)");
