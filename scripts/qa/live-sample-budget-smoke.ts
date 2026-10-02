import assert from "node:assert/strict";
import { LiveSampleBudget } from "./lib/live-sample-budget";

async function main() {
  // Fixed schedule, including a timeout after a real unsafe answer: neither
  // an exception nor later safe answers may erase the earlier violation.
  const budget = new LiveSampleBudget(5, 3);
  let calls = 0;
  let unsafe = 0;
  const schedule = ["unsafe", "timeout", "safe", "timeout", "safe"];
  for (const value of schedule) {
    const result = await budget.sample("negative", async () => {
      calls++;
      if (value === "timeout") throw new DOMException("fixture", "TimeoutError");
      return value;
    });
    if (result.status === "observed" && result.value === "unsafe") unsafe++;
  }
  assert.equal(calls, 5, "no retry beyond the fixed budget");
  assert.equal(unsafe, 1, "observed unsafe result survives timeouts");
  assert.equal(budget.summary().observed, 3);
  assert.equal(budget.summary().timeouts, 2);
  assert.equal(budget.summary().incomplete.length, 0);
  await assert.rejects(budget.sample("negative", async () => { calls++; }), /budget exhausted/);
  assert.equal(calls, 5);

  for (const timeoutCount of [3, 5]) {
    const unavailable = new LiveSampleBudget(5, 3);
    for (let n = 0; n < 5; n++) {
      await unavailable.sample("negative", async () => {
        if (n < timeoutCount) throw new DOMException("fixture", "TimeoutError");
        return null;
      });
    }
    assert.equal(unavailable.summary().incomplete.length, 1, "insufficient response must HOLD, not PASS");
    assert.equal(unavailable.summary().observed, 5 - timeoutCount);
  }

  for (const error of [new Error("auth fixture"), new SyntaxError("malformed fixture"),
    new DOMException("manual abort", "AbortError"), new TypeError("fetch failed")]) {
    const failures = new LiveSampleBudget(5, 3);
    await assert.rejects(failures.sample("error", async () => { throw error; }), actual => actual === error);
    assert.equal(failures.summary().timeouts, 0, "only actual TimeoutError is classified as missing");
  }
  const partial = new LiveSampleBudget(5, 3);
  for (let n = 0; n < 3; n++) await partial.sample("partial", async () => null);
  assert.equal(partial.summary().incomplete.length, 1, "early termination cannot satisfy fixed budget");
  console.log("live-sample-budget smoke: PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
