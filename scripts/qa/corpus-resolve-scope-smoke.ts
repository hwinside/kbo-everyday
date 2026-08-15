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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  buildCheckpointFingerprint,
  INTERVAL_FLOOR_MS,
  INTERVAL_JITTER_MS,
  INTERVAL_PROBE_SCHEDULE_MS,
  INTERVAL_PROBE_STEP_SUCCESSES,
  intervalForSuccessCount,
  intervalWithJitter,
  MAX_PROBES_PER_PLAYER,
  mergeResultRows,
  parseCheckpointText,
  resolvePlayerBatch,
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

const snapshot = JSON.parse(readFileSync(path.join(process.cwd(), SNAPSHOT_PATH), "utf8")) as Snapshot & {
  generatedAt: string;
  rosterSha256: string;
};

// (0) fixture ↔ 런타임 대조 — 스냅샷이 가리키는 로스터가 지금 repo의 로스터와 같은 것이어야
// 488 대상 선정이 유효하다. 로스터가 바뀌면 여기서 막혀 스냅샷 재생성을 강제한다(drift 검출).
const rosterActualSha = createHash("sha256")
  .update(readFileSync(path.join(process.cwd(), "src/lib/constants/players-roster.json")))
  .digest("hex");
assert.equal(rosterActualSha, snapshot.rosterSha256,
  "스냅샷 rosterSha256이 현재 repo 로스터와 불일치 — 스냅샷 재생성 필요(fail-close)");
assert.ok(Number.isFinite(Date.parse(snapshot.generatedAt)), "generatedAt이 유효한 시각이어야 한다");

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

// (3) 간격 계약 — 승인된 8→6→4→2초 probe 스케줄(5초 하드코딩 없음) + 전구간 10초 미만 + 바닥
assert.deepEqual([...INTERVAL_PROBE_SCHEDULE_MS], [8_000, 6_000, 4_000, 2_000], "승인된 probe 스케줄 그대로");
assert.ok(INTERVAL_PROBE_SCHEDULE_MS.every((ms) => ms < 10_000 && ms >= INTERVAL_FLOOR_MS), "전 구간 <10초, 바닥 이상");
assert.equal(intervalForSuccessCount(0), 8_000, "시작은 8초");
assert.equal(intervalForSuccessCount(INTERVAL_PROBE_STEP_SUCCESSES), 6_000, "1단계 하강");
assert.equal(intervalForSuccessCount(INTERVAL_PROBE_STEP_SUCCESSES * 2), 4_000, "2단계 하강");
assert.equal(intervalForSuccessCount(INTERVAL_PROBE_STEP_SUCCESSES * 3), 2_000, "3단계 하강");
assert.equal(intervalForSuccessCount(10_000), 2_000, "바닥 아래로 내려가지 않는다");
for (let i = 0; i < 200; i += 1) {
  const value = intervalWithJitter(2_000);
  assert.ok(value >= 2_000 && value <= 2_000 + INTERVAL_JITTER_MS, `지터 범위 위반: ${value}`);
}

// (3b) request budget 계약 — 기본 후보 3 + 동음이의 상한 6 = 인당 9 명시, budget_exhausted는 missing과 분리
assert.equal(MAX_PROBES_PER_PLAYER, 9, "인당 요청 예산 9 명시");

// (4) 전역 중단 + 직접 실행 가드 — 소스 계약(실행 주입이 안 되는 네트워크 축의 최소 고정).
const source = readFileSync(path.join(process.cwd(), "scripts/baseball-qa/resolve-rag-urls.ts"), "utf8");
assert.ok(/outcome\.blocked[\s\S]{0,700}process\.exit\(2\)/.test(source),
  "blocked → 전역 즉시 중단(exit 2) 계약이 main에 존재해야 한다");
assert.ok(/runBlocked = true;\s*break;/.test(source),
  "배치 함수는 첫 blocked에서 루프를 즉시 이탈해야 한다");
assert.ok(source.includes("if (isDirectRun)"), "직접 실행 가드 존재(스모크 import 안전)");
assert.ok(source.includes('"budget_exhausted"') && source.includes("budgetExhausted"),
  "budget_exhausted 상태가 missing과 분리된 별도 판정으로 존재");
assert.ok(/FETCHER === "cdp" && SOURCE !== "namu"[\s\S]{0,200}process\.exit\(1\)/.test(source),
  "cdp fetcher는 namu 강제 — wiki 오실행 즉시 실패 가드");
assert.ok(source.includes('t: "probe"') && source.includes("replayByTitle"),
  "checkpoint는 (kboId, candidateUrl) probe 단위 기록 + replay로 재요청 차단");

// (5) 대표 코호트 고정 — 삼순 계약 6번 축
const byName = new Map(snapshot.players.map((p) => [p.name, p] as const));
assert.equal(byName.get("김재환")?.kboId, "78224", "김재환(78224) = 외부 해석 대상");
assert.equal(byName.get("김재환")?.bucket, "외부 해석 필요");
assert.ok(picked.some((t) => t.kboId === "78224"), "김재환은 해석 대상에 포함");
assert.equal(byName.get("네이선 와일스")?.kboId, "FP019", "외국인 풀네임 코호트 존재");
assert.ok(picked.some((t) => t.kboId === "FP019"), "외국인 풀네임도 해석 대상");
assert.equal(byName.get("김요셉")?.bucket, "외부 해석 필요", "오문서 격리 대표(김요셉)도 재해석 대상");
assert.ok(!byName.has("원태인"), "기존 ready(원태인 69446)는 스냅샷 밖 — 건드리지 않는다");
assert.deepEqual(
  snapshot.players.filter((p) => p.bucket === "적재만(기존 corpus 재사용)").map((p) => p.name).sort(),
  ["양의지", "장성우", "최형우"],
  "corpus 재사용 3명 exact",
);
{
  const dupInPicked = new Map<string, number>();
  for (const t of picked) dupInPicked.set(t.name, (dupInPicked.get(t.name) ?? 0) + 1);
  assert.ok([...dupInPicked.values()].some((count) => count >= 2), "동명이인 코호트가 해석 대상에 존재");
}

// (7) checkpoint 파서 행동 테스트 — main이 쓰는 실제 함수(parseCheckpointText)를 직접 태운다.
const fp = buildCheckpointFingerprint({ source: "namu", scope: "snapshot", snapshotSha256: "abc123", rosterSha256: "roster-abc" });
const verdictRow = {
  sourceKey: "namu:player:50066", kboId: "50066", name: "강현우", source: "namu",
  status: "resolved", canonicalUrl: "https://namu.wiki/w/강현우", pageTitle: "강현우",
  candidateUrls: ["https://namu.wiki/w/강현우"], note: "-",
};
const goodText = [
  JSON.stringify(fp),
  JSON.stringify({ t: "probe", kboId: "78224", source: "namu", name: "김재환", birthYear: "1988", title: "김재환", url: "https://namu.wiki/w/김재환", kind: "rejected", reason: "disambiguation_document", candidates: ["김재환(야구선수)"], at: "2026-08-15T12:00:00Z" }),
  JSON.stringify({ t: "verdict", row: verdictRow, at: "2026-08-15T12:00:05Z" }),
].join("\n");
const parsedCp = parseCheckpointText(goodText, fp);
assert.equal(parsedCp.doneRows.length, 1, "verdict 행 → full row 복원");
assert.equal(parsedCp.doneRows[0].kboId, "50066");
assert.equal(parsedCp.doneRows[0].note, "-", "full ResultRow 복원(판정표 유실 금지)");
assert.ok(!parsedCp.doneRows.some((r) => r.kboId === "78224"), "probe만 있는 선수는 done이 아니다");
assert.equal(parsedCp.probedByKboId.get("78224")?.[0]?.candidates?.[0], "김재환(야구선수)",
  "probe replay에 파생 후보가 복원된다");
// RED 1: fingerprint 불일치(다른 스냅샷·다른 판정 리비전) — 반드시 던진다.
assert.throws(() => parseCheckpointText(goodText, { ...fp, snapshotSha256: "different" }), /fingerprint 불일치/);
assert.throws(() => parseCheckpointText(goodText, { ...fp, rosterSha256: "other-roster" }), /rosterSha256/,
  "로스터 변경(생년 정정 포함) 후 구 checkpoint 재사용 금지");
assert.throws(() => parseCheckpointText(goodText, { ...fp, resolverRevision: "old" }), /resolverRevision/,
  "판정 로직 리비전이 다르면 구 checkpoint 재사용 금지");
assert.throws(() => parseCheckpointText(goodText, { ...fp, canonicalGateVersion: "r2" }), /canonicalGateVersion/,
  "canonical 게이트 버전 불일치도 fail-close");
// RED 2: 헤더 부재(구버전/손상 파일) — 신규 생성으로 삼켜지지 않고 던진다.
assert.throws(() => parseCheckpointText(goodText.split("\n").slice(1).join("\n"), fp), /fingerprint가 아니다|헤더/);
// RED 3: 중간 줄 JSON 손상 — 던진다.
assert.throws(() => parseCheckpointText(`${goodText}\n{broken`, fp), /JSON 손상/);
// RED 4: 스키마 오류(허용 안 된 status·row 부재) — 던진다. blocked는 verdict로 봉인 금지 계약.
assert.throws(
  () => parseCheckpointText(`${goodText}\n${JSON.stringify({ t: "verdict", row: { ...verdictRow, kboId: "1", status: "blocked" } })}`, fp),
  /스키마 오류/,
);
assert.throws(
  () => parseCheckpointText(`${goodText}\n${JSON.stringify({ t: "verdict", kboId: "1", status: "resolved" })}`, fp),
  /스키마 오류/,
  "구 포맷(flat verdict)은 full row가 아니므로 fail-close",
);
// RED 5 (삼순 3차 P0 의미 검증): 빈 canonicalUrl probe / resolved인데 canonical 결측 /
// 비-resolved인데 canonical 잔존 / sourceKey 불일치 — 전부 던져야 한다.
const probeIdentity = { source: "namu", name: "x", birthYear: "1990" };
assert.throws(
  () => parseCheckpointText(
    `${goodText}\n${JSON.stringify({ t: "probe", kboId: "78224", ...probeIdentity, title: "x", url: "https://namu.wiki/w/x", kind: "canonical", canonicalUrl: "", pageTitle: "", redirected: false })}`,
    fp,
  ),
  /canonical probe 의미 오류/,
  "빈 canonicalUrl을 replay가 resolved로 만드는 경로 차단",
);
assert.throws(
  () => parseCheckpointText(
    `${goodText}\n${JSON.stringify({ t: "probe", kboId: "78224", ...probeIdentity, title: "x", url: "https://namu.wiki/w/x", kind: "rejected" })}`,
    fp,
  ),
  /probe 의미 오류/,
  "rejected probe의 reason 결측 차단",
);
// RED 6 (삼순 4차 P0 신원 결속): 신원 필드 결측 / 타 호스트 URL / candidates 비문자열 — 전부 던진다.
assert.throws(
  () => parseCheckpointText(
    `${goodText}\n${JSON.stringify({ t: "probe", kboId: "78224", title: "x", url: "https://namu.wiki/w/x", kind: "rejected", reason: "r" })}`,
    fp,
  ),
  /신원 결속 결측/,
  "probe 신원 필드(source·name·birthYear) 결측 차단",
);
assert.throws(
  () => parseCheckpointText(
    `${goodText}\n${JSON.stringify({ t: "probe", kboId: "78224", ...probeIdentity, title: "x", url: "https://evil.example/w/x", kind: "rejected", reason: "r" })}`,
    fp,
  ),
  /URL 호스트/,
  "타 호스트 probe URL 차단",
);
assert.throws(
  () => parseCheckpointText(
    `${goodText}\n${JSON.stringify({ t: "probe", kboId: "78224", ...probeIdentity, title: "x", url: "https://namu.wiki/w/x", kind: "rejected", reason: "r", candidates: [1] })}`,
    fp,
  ),
  /candidates 스키마/,
  "candidates 비문자열 차단",
);
assert.throws(
  () => parseCheckpointText(
    `${JSON.stringify(fp)}\n${JSON.stringify({ t: "verdict", row: { ...verdictRow, canonicalUrl: "https://evil.example/w/강현우" } })}`,
    fp,
  ),
  /URL 호스트/,
  "resolved verdict 타 호스트 canonical 차단",
);
// RED 7 (삼순 5차 P0 스키마 우회 차단): 빈 probe url / 빈 candidateUrls / 비문자열 / 타 host.
assert.throws(
  () => parseCheckpointText(
    `${JSON.stringify(fp)}\n${JSON.stringify({ t: "probe", kboId: "78224", ...probeIdentity, title: "x", url: "", kind: "rejected", reason: "r" })}`,
    fp,
  ),
  /probe URL 결측/,
  "빈 probe url 차단(length>0 조건부 검증 우회 불가)",
);
assert.throws(
  () => parseCheckpointText(
    `${JSON.stringify(fp)}\n${JSON.stringify({ t: "verdict", row: { ...verdictRow, candidateUrls: [] } })}`,
    fp,
  ),
  /candidateUrls가 비었다/,
  "빈 candidateUrls 차단",
);
assert.throws(
  () => parseCheckpointText(
    `${JSON.stringify(fp)}\n${JSON.stringify({ t: "verdict", row: { ...verdictRow, candidateUrls: [1] } })}`,
    fp,
  ),
  /candidateUrls URL 결측/,
  "비문자열 candidateUrls 차단(DB builder 도달 전)",
);
assert.throws(
  () => parseCheckpointText(
    `${JSON.stringify(fp)}\n${JSON.stringify({ t: "verdict", row: { ...verdictRow, candidateUrls: ["https://evil.example/w/x"] } })}`,
    fp,
  ),
  /candidateUrls URL 호스트/,
  "타 host candidateUrls 차단",
);
assert.throws(
  () => parseCheckpointText(
    `${JSON.stringify(fp)}\n${JSON.stringify({ t: "verdict", row: { ...verdictRow, canonicalUrl: null } })}`,
    fp,
  ),
  /resolved verdict에 canonicalUrl/,
  "resolved인데 canonical 결측 차단",
);
assert.throws(
  () => parseCheckpointText(
    `${JSON.stringify(fp)}\n${JSON.stringify({ t: "verdict", row: { ...verdictRow, status: "missing" } })}`,
    fp,
  ),
  /verdict에 canonicalUrl\/pageTitle이 남아 있다/,
  "비-resolved인데 canonical 잔존 차단",
);
assert.throws(
  () => parseCheckpointText(
    `${JSON.stringify(fp)}\n${JSON.stringify({ t: "verdict", row: { ...verdictRow, sourceKey: "namu:player:99999" } })}`,
    fp,
  ),
  /sourceKey 불일치/,
  "sourceKey↔kboId 정합 깨짐 차단",
);
// RED 5: 알 수 없는 행 타입 — 던진다.
assert.throws(() => parseCheckpointText(`${goodText}\n${JSON.stringify({ t: "junk", kboId: "1" })}`, fp), /알 수 없는 행/);

// (8) snapshot 모드 실행 계약 가드 — 소스 계약(namu+cdp+dry-run+checkpoint+out 전부 강제).
assert.ok(/SCOPE === "snapshot"[\s\S]{0,900}--source=namu 필수[\s\S]{0,900}--dry-run 필수[\s\S]{0,900}--checkpoint[\s\S]{0,600}--out/.test(source),
  "snapshot 모드는 namu+cdp+dry-run+checkpoint+out 전부 강제");
assert.ok(/--source 값이 잘못됐다|\(wikipedia\|namu\)/.test(source), "enum 오타 즉시 실패 가드 존재");

// (9) 주입 fetcher 행동 게이트(삼순 2차 P0) — main과 같은 실행 함수(resolvePlayerBatch)를
// fake fetcher로 태운다: run1 중단 → run2 resume → 같은 URL 재요청 0 → 최종 합본 unique,
// budget_exhausted≠missing까지 실행 경로로 검증한다.
async function behaviorGate(): Promise<void> {
  const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
  const work = mkdtempSync(path.join(tmpdir(), "resolve-batch-smoke-"));
  const cp = path.join(work, "checkpoint.jsonl");
  const runFp = buildCheckpointFingerprint({ source: "namu", scope: "targets", snapshotSha256: "-", rosterSha256: "mini-roster" });
  wf(cp, `${JSON.stringify(runFp)}\n`, "utf8");

  const rosterMini = [
    { kboId: "10001", name: "가선수", team: "T", birthDate: "2000-01-01" },
    { kboId: "10002", name: "나선수", team: "T", birthDate: "2001-01-01" },
    { kboId: "10003", name: "다선수", team: "T", birthDate: "2002-01-01" },
  ];
  const deps = (probeImpl: (title: string) => Promise<unknown>, calls: string[]) => ({
    source: "namu" as const,
    byKboId: new Map(rosterMini.map((p) => [p.kboId, p] as const)),
    nameCounts: new Map(rosterMini.map((p) => [p.name, 1] as const)),
    nameBirthCounts: new Map(rosterMini.map((p) => [`${p.name}|${p.birthDate.slice(0, 4)}`, 1] as const)),
    probedByKboId: parseCheckpointText(rf(cp, "utf8"), runFp).probedByKboId,
    checkpointPath: cp,
    log: () => undefined,
    probe: async (title: string) => {
      calls.push(title);
      return await probeImpl(title) as never;
    },
  });

  // run1: 가선수 resolved 확정 후 나선수에서 blocked → 전역 중단.
  const targetsAll = rosterMini.map(({ kboId, name }) => ({ kboId, name }));
  const calls1: string[] = [];
  const canonicalOf = (title: string) => ({
    kind: "canonical", url: `https://namu.wiki/w/${title}`, canonicalUrl: `https://namu.wiki/w/${title}`,
    pageTitle: title, redirected: false,
  });
  const run1 = await resolvePlayerBatch(targetsAll, deps(async (title) =>
    title.includes("가선수") ? canonicalOf(title) : { kind: "blocked", url: "u", reason: "bot_protection_http_403" }, calls1));
  assert.equal(run1.blocked, true, "run1은 blocked로 중단된다");
  assert.equal(run1.rows.filter((r) => r.status === "resolved").length, 1, "중단 전 완료 1명");
  const cpAfterRun1 = rf(cp, "utf8");
  assert.ok(!cpAfterRun1.includes('"blocked"'), "blocked는 checkpoint에 봉인되지 않는다");

  // run2 resume: done 복원 + 같은 URL 재요청 0 + 최종 합본 3명 unique.
  const resumed = parseCheckpointText(rf(cp, "utf8"), runFp);
  assert.equal(resumed.doneRows.length, 1, "resume이 full ResultRow를 복원한다(유실 금지)");
  assert.equal(resumed.doneRows[0].status, "resolved");
  const remaining = targetsAll.filter((t) => !resumed.doneRows.some((r) => r.kboId === t.kboId));
  const calls2: string[] = [];
  const run2 = await resolvePlayerBatch(remaining, {
    ...deps(async (title) => canonicalOf(title), calls2),
    probedByKboId: resumed.probedByKboId,
  });
  assert.equal(run2.blocked, false);
  const finalRows = mergeResultRows(resumed.doneRows, run2.rows);
  assert.equal(finalRows.length, 3, "최종 판정표 = 이전 완료 + 신규, 유실 0");
  assert.ok(!calls2.some((title) => title.includes("가선수")), "완료된 선수 URL 재요청 0");
  assert.throws(() => mergeResultRows(resumed.doneRows, [...run2.rows, resumed.doneRows[0]]), /kboId 중복/,
    "중복 병합은 fail-close");

  // budget_exhausted ≠ missing — 동음이의 파생 후보가 예산(9)을 넘도록 주입.
  const manyLinks = Array.from({ length: 12 }, (_, i) => `<a href="/w/다선수(${2000 + i})">x</a>`).join("");
  const calls3: string[] = [];
  const run3 = await resolvePlayerBatch([{ kboId: "10003", name: "다선수" }], {
    ...deps(async () => ({ kind: "rejected", url: "u", reason: "disambiguation_document", disambiguationHtml: manyLinks }), calls3),
    checkpointPath: null,
    probedByKboId: new Map(),
  });
  assert.equal(run3.rows[0].status, "budget_exhausted", "예산 소진은 missing이 아니다");
  assert.equal(calls3.length, MAX_PROBES_PER_PLAYER, "요청 수 = 예산 상한 exact");
  console.log("행동 게이트 PASS — run1중단→resume→재요청0→합본 unique / budget_exhausted 실행경로");

  // ── 완주-checkpoint CLI 게이트(삼순 4차 P0/P1) ────────────────────────────────
  // 실제 CLI를 전원 완료 checkpoint로 재실행: 외부 요청 0 → --out 복원, 그리고
  // non-dry-run은 DB upsert 단계를 실제로 탄다(앞 run DB 부분 실패 재시도 경로).
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const { S2B_TARGET_PLAYERS } = await import("../../src/lib/baseball-qa/rag/targets");
  const realRoster = JSON.parse(rf(path.join(process.cwd(), "src/lib/constants/players-roster.json"), "utf8")) as {
    kboId: string; name: string;
  }[];
  const realById = new Map(realRoster.map((player) => [player.kboId, player] as const));
  const cliFp = buildCheckpointFingerprint({ source: "wikipedia", scope: "targets", snapshotSha256: "-", rosterSha256: rosterActualSha });
  const cliRows = S2B_TARGET_PLAYERS.map(({ kboId }) => {
    const rosterRow = realById.get(kboId);
    assert.ok(rosterRow, `S2B 대상 kboId=${kboId}가 로스터에 있어야 한다`);
    return {
      sourceKey: `wikipedia:player:${kboId}`, kboId, name: rosterRow.name, source: "wikipedia",
      status: "missing", canonicalUrl: null, pageTitle: null,
      candidateUrls: [`https://ko.wikipedia.org/wiki/${encodeURIComponent(rosterRow.name)}`],
      note: "완주 복원 게이트 fixture",
    };
  });
  const cliCp = path.join(work, "cli-checkpoint.jsonl");
  wf(cliCp, [JSON.stringify(cliFp), ...cliRows.map((row) => JSON.stringify({ t: "verdict", row, at: "2026-08-15T12:00:00Z" }))].join("\n") + "\n", "utf8");
  const cliOut = path.join(work, "cli-out.json");

  const runCli = async (extraArgs: string[], extraEnv: Record<string, string>) =>
    await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("npx", ["tsx", "scripts/baseball-qa/resolve-rag-urls.ts",
        "--source=wikipedia", "--scope=targets", `--checkpoint=${cliCp}`, `--out=${cliOut}`, ...extraArgs], {
        cwd: process.cwd(), env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  // (1) dry-run: 외부 요청 0 선언 + out 16명 복원 + DB 생략.
  const dryRestore = await runCli(["--dry-run"], {});
  assert.equal(dryRestore.code, 0, `완주 복원 dry-run은 성공해야 한다:\n${dryRestore.stdout}\n${dryRestore.stderr}`);
  assert.match(dryRestore.stdout, /전원 완료된 checkpoint — 외부 요청 0/);
  const restoredOut = JSON.parse(rf(cliOut, "utf8")) as unknown[];
  assert.equal(restoredOut.length, S2B_TARGET_PLAYERS.length, "완주 복원 out은 대상 전원이어야 한다");
  assert.match(dryRestore.stdout, /--dry-run: DB 쓰기 생략/);

  // (2) non-dry-run: 외부 probe 0이지만 summary/out/**DB upsert**는 그대로 탄다(false success 차단).
  let upsertCount = 0;
  const dbServer = createServer((request, response) => {
    if (request.method === "POST" && request.url?.startsWith("/rest/v1/genius_rag_sources")) {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        upsertCount += 1;
        response.statusCode = 201;
        response.setHeader("content-type", "application/json");
        response.end(body);
      });
      return;
    }
    response.statusCode = 404;
    response.end("[]");
  });
  await new Promise<void>((resolve) => dbServer.listen(0, "127.0.0.1", resolve));
  const dbAddress = dbServer.address();
  assert.ok(dbAddress && typeof dbAddress === "object");
  const applyRestore = await runCli([], {
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${dbAddress.port}`,
    SUPABASE_SERVICE_ROLE_KEY: "smoke-test-key",
  });
  dbServer.close();
  assert.equal(applyRestore.code, 0, `완주 복원 non-dry-run은 DB upsert까지 성공해야 한다:\n${applyRestore.stdout}\n${applyRestore.stderr}`);
  assert.match(applyRestore.stdout, /전원 완료된 checkpoint — 외부 요청 0/);
  assert.equal(upsertCount, S2B_TARGET_PLAYERS.length, "완주 복원 non-dry-run은 전원 DB upsert를 재시도해야 한다");
  assert.match(applyRestore.stdout, new RegExp(`반영 ${S2B_TARGET_PLAYERS.length}/${S2B_TARGET_PLAYERS.length}건`));

  // (3) membership RED(삼순 5차 P0): scope 원집합 밖 roster 선수 1명을 checkpoint에 섞으면
  // 외부 요청 전에 즉시 실패해야 한다(17행 DB 혼입 차단).
  const s2bIds = new Set(S2B_TARGET_PLAYERS.map((player) => player.kboId));
  const outsider = realRoster.find((player) => !s2bIds.has(player.kboId));
  assert.ok(outsider, "S2B 밖 로스터 선수가 있어야 한다");
  const outsiderRow = {
    sourceKey: `wikipedia:player:${outsider.kboId}`, kboId: outsider.kboId, name: outsider.name,
    source: "wikipedia", status: "missing", canonicalUrl: null, pageTitle: null,
    candidateUrls: [`https://ko.wikipedia.org/wiki/${encodeURIComponent(outsider.name)}`],
    note: "membership RED fixture",
  };
  const cliCpBad = path.join(work, "cli-checkpoint-bad.jsonl");
  wf(cliCpBad, [
    JSON.stringify(cliFp),
    ...cliRows.slice(0, 15).map((row) => JSON.stringify({ t: "verdict", row, at: "2026-08-15T12:00:00Z" })),
    JSON.stringify({ t: "verdict", row: outsiderRow, at: "2026-08-15T12:00:00Z" }),
  ].join("\n") + "\n", "utf8");
  const badMembership = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/baseball-qa/resolve-rag-urls.ts",
      "--source=wikipedia", "--scope=targets", `--checkpoint=${cliCpBad}`, `--out=${path.join(work, "bad-out.json")}`, "--dry-run"], {
      cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(badMembership.code, 1, "scope 원집합 밖 verdict 혼입은 즉시 실패해야 한다");
  assert.match(`${badMembership.stdout}${badMembership.stderr}`, /원집합 밖/);
  console.log(`CLI 완주-checkpoint 게이트 PASS — 외부요청0→out ${restoredOut.length}명 복원 / non-dry-run DB upsert ${upsertCount}건 재시도 / 원집합 밖 혼입 RED`);
}

// self-test RED: 검출력 증명 — 조작된 스냅샷은 반드시 잡혀야 한다.
let selfTestRed = false;
try {
  selectResolveTargets(roster, { scope: "snapshot", onlyNames: [], limit: null, snapshotPlayers: [] });
} catch {
  selfTestRed = true;
}
assert.ok(selfTestRed, "self-test: fail-close 경로가 실제로 던진다");

behaviorGate()
  .then(() => {
    console.log(
      "corpus-resolve-scope-smoke PASS (snapshot 491/488·roster해시대조 / checkpoint fingerprint(rev포함)+스키마 RED / "
      + "주입fetcher resume행동 / probe 8→6→4→2s / budget9 / snapshot모드 강제가드 / global-abort / 대표코호트)",
    );
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
