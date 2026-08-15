/**
 * resolver scope/checkpoint/간격 계약 스모크 (2026-08-15, corpus 공백 해소 1단계).
 *
 * 검증 축:
 *  (1) 스냅샷 fixture 정합 — 분모 합계·kboId 유일성·해석 버킷 488 (0단계 실측과 결속)
 *  (2) selectResolveTargets — snapshot 버킷 필터 / resume skip / 빈 스냅샷 fail-close
 *  (3) 간격 계약 — 기본 5초(<10초, 2026-08-15 하린아빠 지시) + 지터 상한, 바닥 3초
 *  (4) 전역 중단 계약 — resolver 소스가 blocked에서 process.exit(2)로 run을 끝내는지
 *      (실행 경로 주입이 어려운 네트워크 축이라 소스 계약 + 순수 함수 이중으로 잡는다)
 *
 * ⚠️ 이 스모크는 외부 요청을 하지 않는다. resolve-rag-urls.ts는 직접 실행 가드가 있어
 * import만으로는 main()이 돌지 않는다 — 그 가드 자체도 여기서 검증한다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_INTERVAL_MS,
  INTERVAL_FLOOR_MS,
  INTERVAL_JITTER_MS,
  intervalWithJitter,
  selectResolveTargets,
} from "../baseball-qa/resolve-rag-urls";

const SNAPSHOT_PATH = "scripts/qa/fixtures/corpus-gap-snapshot-20260815.json";

interface SnapshotPlayer { kboId: string; name: string; bucket: string }
interface Snapshot {
  denominator: number;
  namuServed: number;
  gapTotal: number;
  buckets: Record<string, number>;
  players: SnapshotPlayer[];
}

const snapshot = JSON.parse(readFileSync(path.join(process.cwd(), SNAPSHOT_PATH), "utf8")) as Snapshot;

// (1) 스냅샷 정합 — 0단계 실측과 어긋나면 여기서 멈춘다(조작·drift 검출).
assert.equal(snapshot.denominator, 883, "분모는 origin/main 로스터 883");
assert.equal(snapshot.gapTotal, snapshot.players.length, "players 수 = gapTotal");
assert.equal(
  Object.values(snapshot.buckets).reduce((sum, count) => sum + count, 0),
  snapshot.gapTotal,
  "버킷 합계 = gapTotal (상호배타)",
);
assert.equal(snapshot.namuServed + snapshot.gapTotal, snapshot.denominator, "서빙+공백 = 분모");
assert.equal(new Set(snapshot.players.map((p) => p.kboId)).size, snapshot.players.length, "kboId 유일");
const resolveTargetsCount = snapshot.players.filter(
  (p) => p.bucket === "외부 해석 필요" || p.bucket === "원장 미등록",
).length;
assert.equal(resolveTargetsCount, 488, "외부 해석 대상 488 (485+3)");
assert.equal(snapshot.buckets["적재만(기존 corpus 재사용)"], 3, "census 재사용 3명");

// (2) selectResolveTargets 계약
const roster = snapshot.players.map(({ kboId, name }) => ({ kboId, name, team: "" }));
const picked = selectResolveTargets(roster, {
  scope: "snapshot", onlyNames: [], limit: null, snapshotPlayers: snapshot.players,
});
assert.equal(picked.length, 488, "snapshot scope는 해석 버킷만 통과");
const sorted = [...picked].sort((a, b) => a.kboId.localeCompare(b.kboId));
assert.deepEqual(picked, sorted, "kboId 오름차순 고정(분할 실행 안정성)");
// 적재만 3명(양의지 76232 등)은 재크롤 대상이 아니다.
assert.ok(!picked.some((t) => t.kboId === "76232"), "census 재사용 3명은 해석 대상에서 제외");

const done = new Set(picked.slice(0, 100).map((t) => t.kboId));
const resumed = selectResolveTargets(roster, {
  scope: "snapshot", onlyNames: [], limit: null, snapshotPlayers: snapshot.players, doneKboIds: done,
});
assert.equal(resumed.length, 388, "resume: checkpoint 기록분 skip");
assert.ok(resumed.every((t) => !done.has(t.kboId)), "resume 후 중복 대상 0");

assert.throws(
  () => selectResolveTargets(roster, { scope: "snapshot", onlyNames: [], limit: null, snapshotPlayers: [] }),
  /fail-close/,
  "빈 스냅샷은 조용한 전체 통과가 아니라 즉시 실패",
);

// (3) 간격 계약 — 10초 미만(하린아빠 지시) + 바닥 3초 + 지터 경계
assert.ok(DEFAULT_INTERVAL_MS < 10_000, "기본 간격은 10초 미만");
assert.ok(DEFAULT_INTERVAL_MS >= INTERVAL_FLOOR_MS, "기본 간격은 바닥(3초) 이상");
for (let i = 0; i < 200; i += 1) {
  const value = intervalWithJitter();
  assert.ok(value >= DEFAULT_INTERVAL_MS && value <= DEFAULT_INTERVAL_MS + INTERVAL_JITTER_MS,
    `지터 범위 위반: ${value}`);
}

// (4) 전역 중단 + 직접 실행 가드 — 소스 계약(실행 주입이 안 되는 네트워크 축의 최소 고정).
const source = readFileSync(path.join(process.cwd(), "scripts/baseball-qa/resolve-rag-urls.ts"), "utf8");
assert.ok(/verdict\.status === "blocked"[\s\S]{0,700}process\.exit\(2\)/.test(source),
  "blocked → 전역 즉시 중단(exit 2) 계약이 소스에 존재해야 한다");
assert.ok(source.includes("if (isDirectRun)"), "직접 실행 가드 존재(스모크 import 안전)");

// self-test RED: 검출력 증명 — 조작된 스냅샷은 반드시 잡혀야 한다.
let selfTestRed = false;
try {
  selectResolveTargets(roster, { scope: "snapshot", onlyNames: [], limit: null, snapshotPlayers: [] });
} catch {
  selfTestRed = true;
}
assert.ok(selfTestRed, "self-test: fail-close 경로가 실제로 던진다");

console.log("corpus-resolve-scope-smoke PASS (snapshot 488 / resume / interval<10s / global-abort 계약)");
