#!/usr/bin/env node
/** 실제 병합 함수 회귀: 정규식이 아니라 배포 함수 자체를 실행한다. */
import assert from "node:assert/strict";
import { mergeCumulativeSeries } from "../../src/lib/admin/active-users-hybrid.ts";

const ga = [
  { date: "2026-06-23", users: 80, pv: 400 },
  { date: "2026-06-24", users: 100, pv: 500 },
];
const own = [
  { date: "2026-06-25", users: 7, pv: 30 },
  { date: "2026-06-26", users: 12, pv: 55 },
];
assert.deepEqual(mergeCumulativeSeries(ga, own), [
  ...ga,
  { date: "2026-06-25", users: 107, pv: 530 },
  { date: "2026-06-26", users: 112, pv: 555 },
]);

assert.throws(() => mergeCumulativeSeries([], own), /no rows/);
assert.throws(
  () => mergeCumulativeSeries(ga, [{ date: "2026-06-24", users: 1, pv: 1 }]),
  /crossed GA4 boundary/,
);
assert.throws(
  () => mergeCumulativeSeries([{ date: "2026-06-25", users: 1, pv: 1 }], own),
  /crossed internal boundary/,
);
assert.throws(
  () => mergeCumulativeSeries([
    { date: "2026-06-24", users: 1, pv: 1 },
    { date: "2026-06-23", users: 2, pv: 2 },
  ], own),
  /invalid or unordered/,
);
assert.throws(
  () => mergeCumulativeSeries(ga, [{ date: "2026-06-25", users: Number.NaN, pv: 1 }]),
  /values are invalid/,
);

console.log("active-users hybrid: PASS (정상 경계 병합 + 빈/경계/날짜/수치 fail-close 5축)");
