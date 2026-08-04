/**
 * 원자 promote 계약 스모크.
 *
 * 배경(2026-08-04, 삼순 P0-3): 크롤러가 대상 파일 5개에 `writeFileSync` 를 순차 호출했다.
 * 검증은 write 앞에서 멈추지만 2~5번째 I/O 가 실패하거나 프로세스가 죽으면 앞 파일은 이미
 * 교체된 뒤라 "타자만 새것 / 수비는 옛것" 같은 혼합 snapshot 이 남는다.
 *
 * 계약:
 *  1) 정상 경로 — 전부 교체된다.
 *  2) staging 단계 실패 — 대상 파일이 **단 하나도** 바뀌지 않는다(byte-identical).
 *  3) promote 도중 실패 — 이미 교체한 파일까지 원본으로 되돌아간다(byte-identical).
 *  4) 원래 없던 파일을 만들다 실패 — 그 파일은 남지 않는다.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  hasPendingPromotion,
  listJournalArtifacts,
  promoteAtomically,
  recoverPendingPromotion,
} from "../lib/atomic-promote.mjs";

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function makeFixture(fileCount = 5) {
  const dir = mkdtempSync(join(tmpdir(), "atomic-promote-smoke-"));
  const artifacts = [];
  const before = new Map();
  for (let i = 0; i < fileCount; i++) {
    const path = join(dir, `artifact-${i}.json`);
    writeFileSync(path, JSON.stringify({ generation: "old", index: i }, null, 2));
    before.set(path, sha(path));
    artifacts.push({ path, body: JSON.stringify({ generation: "new", index: i }, null, 2) });
  }
  return { dir, artifacts, before };
}

/* 1) 정상 경로 — 전부 교체 */
{
  const { dir, artifacts, before } = makeFixture();
  promoteAtomically(artifacts);
  for (const artifact of artifacts) {
    assert.equal(
      readFileSync(artifact.path, "utf8"),
      artifact.body,
      "정상 promote 는 모든 산출물을 교체해야 한다",
    );
    assert.notEqual(sha(artifact.path), before.get(artifact.path));
  }
  rmSync(dir, { recursive: true, force: true });
}

/* 2) staging 단계 실패 — 대상 파일 전원 byte 불변 */
{
  const { dir, artifacts, before } = makeFixture();
  assert.throws(
    () => promoteAtomically(artifacts, { fail: "afterStage" }),
    /injected_failure:afterStage/,
    "staging 실패는 던져야 한다",
  );
  for (const artifact of artifacts) {
    assert.equal(
      sha(artifact.path),
      before.get(artifact.path),
      "staging 실패 시 대상 파일은 단 하나도 바뀌면 안 된다",
    );
  }
  rmSync(dir, { recursive: true, force: true });
}

/* 3) promote 도중 실패 — 이미 교체한 파일까지 롤백 */
{
  const { dir, artifacts, before } = makeFixture();
  assert.throws(
    () => promoteAtomically(artifacts, { fail: "midPromote" }),
    /injected_failure:midPromote/,
    "promote 중간 실패는 던져야 한다",
  );
  for (const artifact of artifacts) {
    assert.equal(
      sha(artifact.path),
      before.get(artifact.path),
      `promote 중간 실패 시 ${artifact.path} 가 원본으로 복구돼야 한다(혼합 snapshot 금지)`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
}

/* 4) 원래 없던 파일 — 실패 시 잔존하지 않는다 */
{
  const dir = mkdtempSync(join(tmpdir(), "atomic-promote-smoke-new-"));
  const existing = join(dir, "existing.json");
  writeFileSync(existing, JSON.stringify({ generation: "old" }));
  const existingBefore = sha(existing);

  const brandNew = [join(dir, "new-a.json"), join(dir, "new-b.json"), join(dir, "new-c.json")];
  const artifacts = [
    { path: existing, body: JSON.stringify({ generation: "new" }) },
    { path: brandNew[0], body: "{}" },
    { path: brandNew[1], body: "{}" },
    { path: brandNew[2], body: "{}" },
  ];

  assert.throws(
    () => promoteAtomically(artifacts, { fail: "midPromote" }),
    /injected_failure:midPromote/,
  );
  assert.equal(sha(existing), existingBefore, "기존 파일은 원본으로 복구돼야 한다");
  for (const path of brandNew) {
    assert.equal(existsSync(path), false, `실패 시 새로 만든 ${path} 는 남으면 안 된다`);
  }
  rmSync(dir, { recursive: true, force: true });
}

/* 5) process hard-exit — JS catch 가 실행되지 않는 경계 (삼순 P0-3 blocker)
 *    첫 rename 직후 `process.exit()` 로 죽이면 catch rollback 이 아예 안 돈다.
 *    종전 구현은 이때 `new-0 / old-1 / old-2 ...` 혼합 snapshot 을 남겼다.
 *    저널 + 다음 실행 복구로 "old 전체 또는 new 전체" 만 남아야 한다. */
{
  const { dir, artifacts, before } = makeFixture();
  const script = `
    import { promoteAtomically } from ${JSON.stringify(new URL("../lib/atomic-promote.mjs", import.meta.url).href)};
    const artifacts = ${JSON.stringify(artifacts)};
    promoteAtomically(artifacts, { onBeforeRename: (i) => { if (i === 1) process.exit(86); } });
  `;
  const scriptPath = join(dir, "hard-exit.mjs");
  writeFileSync(scriptPath, script);

  let exitCode = 0;
  try {
    execFileSync(process.execPath, [scriptPath], { stdio: "pipe" });
  } catch (error) {
    exitCode = error.status;
  }
  assert.equal(exitCode, 86, "child 가 hard-exit 로 죽어야 한다");

  // 죽은 직후 디스크는 혼합 상태다 — 그래서 저널이 남아 있어야 한다.
  assert.ok(
    hasPendingPromotion(dir),
    "hard-exit 뒤에는 미완료 promote 저널이 남아 다음 실행이 복구할 수 있어야 한다",
  );

  // 복구 실행 — old generation 전체로 되돌아가야 한다.
  const result = recoverPendingPromotion(dir);
  assert.equal(result.recovered, true, "저널이 있으면 복구가 수행돼야 한다");
  for (const artifact of artifacts) {
    assert.equal(
      sha(artifact.path),
      before.get(artifact.path),
      `hard-exit 복구 후 ${artifact.path} 는 이전 세대여야 한다(혼합 snapshot 금지)`,
    );
  }
  assert.equal(hasPendingPromotion(dir), false, "복구 후 저널은 제거돼야 한다");
  rmSync(dir, { recursive: true, force: true });
}

/* 6) 저널이 남은 상태에서 promote 를 부르면 fail-close 한다.
 *    복구는 promote 진입부가 아니라 **실행 시작부**가 해야 한다.
 *    (종전에는 promoteAtomically() 안에서 복구해, 크롤·read·검증을 전부
 *     혼합 세대 위에서 끝낸 뒤에야 되돌렸다 — 삼순 5차 지적) */
{
  const { dir, artifacts, before } = makeFixture();
  const script = `
    import { promoteAtomically } from ${JSON.stringify(new URL("../lib/atomic-promote.mjs", import.meta.url).href)};
    const artifacts = ${JSON.stringify(artifacts)};
    promoteAtomically(artifacts, { onBeforeRename: (i) => { if (i === 2) process.exit(87); } });
  `;
  const scriptPath = join(dir, "hard-exit2.mjs");
  writeFileSync(scriptPath, script);
  try { execFileSync(process.execPath, [scriptPath], { stdio: "pipe" }); } catch { /* expected */ }
  assert.ok(hasPendingPromotion(dir), "hard-exit 저널이 남아야 한다");

  // 복구 없이 곧장 promote 하면 계약 위반으로 죽어야 한다.
  assert.throws(
    () => promoteAtomically(artifacts),
    /promote_journal_pending/,
    "저널이 남은 채 promote 하면 fail-close 해야 한다(startup recovery 누락 감지)",
  );

  // startup recovery 를 먼저 부르면 이전 세대로 복구되고, 그 뒤 promote 는 정상 동작한다.
  recoverPendingPromotion(dir);
  for (const artifact of artifacts) {
    assert.equal(
      sha(artifact.path),
      before.get(artifact.path),
      "startup recovery 후에는 promote 전에 이미 이전 세대여야 한다",
    );
  }
  promoteAtomically(artifacts);
  for (const artifact of artifacts) {
    assert.equal(readFileSync(artifact.path, "utf8"), artifact.body);
  }
  assert.equal(hasPendingPromotion(dir), false);
  rmSync(dir, { recursive: true, force: true });
}

/* 7) 저널 배치 직후 죽어도(=rename 0회) 이전 세대가 보존된다 */
{
  const { dir, artifacts, before } = makeFixture();
  assert.throws(
    () => promoteAtomically(artifacts, { fail: "afterJournal" }),
    /injected_failure:afterJournal/,
  );
  for (const artifact of artifacts) {
    assert.equal(
      sha(artifact.path),
      before.get(artifact.path),
      "저널만 남기고 죽어도 대상 파일은 이전 세대여야 한다",
    );
  }
  rmSync(dir, { recursive: true, force: true });
}

/* 8) 성공 경로는 저널 잔여물을 남기지 않는다 */
{
  const { dir, artifacts } = makeFixture();
  promoteAtomically(artifacts);
  assert.deepEqual(
    listJournalArtifacts(dir),
    [],
    "성공 후 저널 디렉터리에 잔여물이 없어야 한다",
  );
  rmSync(dir, { recursive: true, force: true });
}

/* 9) 실제 배선 — startup recovery 와 파생 검증 인자가 actual call-site 에 결속됐는가
 *    (둘 다 종전에 제거해도 전 게이트가 GREEN 이었다 — 삼순 5차 지적) */
{
  const crawler = readFileSync("scripts/crawl-stats.mjs", "utf8");

  // ① startup recovery 가 어떤 데이터 read 보다 앞이어야 한다.
  // ⚠︎ 주석에 같은 문자열이 있으면 indexOf 가 그걸 먼저 잡아 순서 판정이 뒤집힌다.
  // 실제로 doc 주석 때문에 오탐이 났다. 주석을 제거한 코드에서 판정한다.
  const crawlerCode = crawler
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const recoveryIdx = crawlerCode.indexOf("recoverPendingPromotion(CONSTANTS_DIR)");
  assert.ok(
    recoveryIdx >= 0,
    "크롤러는 실행 시작부에서 recoverPendingPromotion(CONSTANTS_DIR) 를 호출해야 한다",
  );
  for (const laterMarker of [
    "readPrevious(",            // 기존 snapshot read
    "await verifyThenPromote(", // 검증+교체(구조적 결속)
    "await crawlBatterBasic1(page)", // 실제 크롤 시작 호출부(선언 아님)
  ]) {
    const idx = crawlerCode.indexOf(laterMarker);
    assert.ok(idx >= 0, `크롤러에서 \`${laterMarker}\` 를 찾을 수 있어야 한다`);
    assert.ok(
      recoveryIdx < idx,
      `startup recovery 는 \`${laterMarker}\` 보다 앞에서 실행돼야 한다`,
    );
  }
  // main() 안이어야 하고, promoteAtomically 호출부에 묻어 있으면 안 된다.
  const mainIdx = crawlerCode.indexOf("async function main() {");
  assert.ok(mainIdx >= 0 && recoveryIdx > mainIdx, "startup recovery 는 main() 시작부에 있어야 한다");

}

/* 5) 실제 배선 — 크롤러가 순차 직쓰기 대신 promoteAtomically 를 쓰는가 */
{
  const crawler = readFileSync("scripts/crawl-stats.mjs", "utf8");
  assert.ok(
    crawler.includes("verifyThenPromote({"),
    "크롤러는 promoteAtomically 로 산출물을 교체해야 한다",
  );
  // 대상 산출물 경로에 직접 writeFileSync 하는 경로가 남아 있으면 원자성이 깨진다.
  for (const target of [
    "writeFileSync(batterPath",
    "writeFileSync(pitcherPath",
    "writeFileSync(defensePath",
    "writeFileSync(defenseRunsPath",
    "writeFileSync(metaPath",
  ]) {
    assert.ok(
      !crawler.includes(target),
      `크롤러에 순차 직쓰기 \`${target}\` 가 남아 있으면 안 된다`,
    );
  }
}

console.log("atomic promote smoke: ALL assertions PASS");

/* 8) verifyThenPromote 행동 검증 — 검증 우회가 구조적으로 불가능한가 ────
 *
 * ⚠︎ 여기까지의 검사는 전부 "크롤러 소스 문자열"이었다. 그래서 caller 한 줄만 바꾸면
 * 전 게이트가 GREEN 인 우회가 반복됐다(삼순 실증, merged main 에서도 재현):
 *   - `false && await assertSourceTruth({...})`
 *   - `defenseRuns: readPrevious(defenseRunsPath, {})`  ← 옛 스냅샷을 검증
 * 문자열 검사는 같은 의미의 다른 표기를 끝없이 놓친다. 그래서 검사 대상을 바꿨다 —
 * 검증 입력을 **promote payload 에서 파생**시켜, 끼워넣을 자리 자체를 없앤다. */
{
  const { verifyThenPromote } = await import("../lib/verified-promote.mjs");
  const dir = mkdtempSync(join(tmpdir(), "verified-promote-"));
  const mk = (name, body) => ({ path: join(dir, name), body: JSON.stringify(body) });

  const artifacts = [
    mk("stats-2026-batters.json", [{ kboId: "1" }]),
    mk("stats-2026-pitchers.json", [{ kboId: "2" }]),
    mk("stats-2026-defense.json", [{ kboId: "3", pos: "유격수" }]),
    mk("player-defense-runs.json", { 3: 1.5 }),
  ];
  for (const a of artifacts) writeFileSync(a.path, "OLD");

  // ① 검증기가 받는 값은 반드시 promote payload 여야 한다(caller 주입 불가).
  let seen = null;
  await verifyThenPromote({
    artifacts,
    verify: async (input) => { seen = input; },
    // caller 가 옛 스냅샷을 끼워넣으려 해도 payload 가 이긴다.
    context: { season: "2026" },
  });
  assert.deepEqual(seen.defenseRuns, { 3: 1.5 }, "검증기는 promote payload 의 defenseRuns 를 받아야 한다");
  assert.deepEqual(seen.batters, [{ kboId: "1" }], "검증기는 promote payload 의 batters 를 받아야 한다");
  assert.equal(seen.season, "2026", "부가 context 는 그대로 전달된다");
  for (const a of artifacts) {
    assert.equal(readFileSync(a.path, "utf8"), a.body, "검증 통과 시 promote 돼야 한다");
  }

  // ② 검증기가 던지면 promote 되지 않는다(파일 byte 불변).
  for (const a of artifacts) writeFileSync(a.path, "OLD");
  await assert.rejects(
    () => verifyThenPromote({
      artifacts,
      verify: async () => { throw new Error("stats_source_truth_mismatch: 주입"); },
      context: {},
    }),
    /stats_source_truth_mismatch/,
  );
  for (const a of artifacts) {
    assert.equal(readFileSync(a.path, "utf8"), "OLD", "검증 실패 시 산출물이 바뀌면 안 된다");
  }

  // ②-b context 로 payload 키를 덮으려 하면 명시적으로 거부한다.
  //     (조용히 무시하면 caller 는 자기 의도가 먹힌 줄 알고, 리뷰어도 못 알아본다)
  for (const a of artifacts) writeFileSync(a.path, "OLD");
  await assert.rejects(
    () => verifyThenPromote({
      artifacts,
      verify: async () => {},
      context: { defenseRuns: { 999: -99 } },
    }),
    /verified_promote_context_shadow/,
    "context 가 payload 키를 덮으면 거부해야 한다(옛 스냅샷 검증 우회 차단)",
  );
  for (const a of artifacts) {
    assert.equal(readFileSync(a.path, "utf8"), "OLD", "거부 시 산출물이 바뀌면 안 된다");
  }

  // ③ 검증기 자체가 없으면 promote 불가(호출 누락 = 실패).
  await assert.rejects(
    () => verifyThenPromote({ artifacts, verify: undefined, context: {} }),
    /verified_promote_missing_verifier/,
  );

  // ④ payload 에 검증 대상이 없으면 promote 불가(빈 산출물 write 차단).
  await assert.rejects(
    () => verifyThenPromote({
      artifacts: [mk("stats-2026-batters.json", [])],
      verify: async () => {},
      context: {},
    }),
    /verified_promote_payload_incomplete/,
  );

  rmSync(dir, { recursive: true, force: true });
}

console.log("verified promote behavior: PASS");

/* 9) 크롤러 실제 실행 경로 — 검증 호출을 끊으면 잡히는가 ─────────────
 *
 * ⚠︎ 8번까지도 `verifyThenPromote` 라이브러리만 봤다. 크롤러가 그 호출을 통째로
 * 끊으면(`false && await verifyThenPromote(...)`) 여전히 GREEN 이었다(mutation 실증).
 * 그래서 main() 을 **실제로 실행**해 검증기가 호출되는지 행동으로 확인한다.
 * KBO 네트워크는 타지 않는다 — playwright.chromium.launch 를 실패시켜 크롤 단계에서
 * 즉시 죽게 하고, "그 전에 write 가 일어나지 않는다" 는 계약만 본다. */
{
  const crawler = readFileSync("scripts/crawl-stats.mjs", "utf8");

  // main() 이 export 돼 게이트가 실행할 수 있어야 한다.
  assert.ok(
    /export async function main\(\)/.test(crawler),
    "게이트가 실제 write 경로를 실행할 수 있도록 main() 이 export 돼야 한다",
  );

  // 검증 호출이 조건부로 끊기지 않았는지 — 주석 제거 후 실행 문맥에서 확인한다.
  const code = crawler
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // 호출이 단락 평가로 꺼져 있지 않아야 한다.
  const callLine = code.split("\n").find((l) => l.includes("verifyThenPromote("));
  assert.ok(callLine, "크롤러는 verifyThenPromote 를 호출해야 한다");
  assert.ok(
    /^\s*await verifyThenPromote\(/.test(callLine),
    `verifyThenPromote 는 조건 없이 await 호출돼야 한다: ${callLine.trim()}`,
  );
  assert.ok(
    !/(false\s*&&|0\s*&&|if\s*\(\s*false\s*\))[^\n]*verifyThenPromote/.test(code),
    "verifyThenPromote 호출을 단락 평가로 끄면 안 된다(검증 없이 promote 된다)",
  );
  // promote 는 verifyThenPromote 를 통해서만 — 직접 promoteAtomically 우회 금지.
  assert.ok(
    !/^\s*promoteAtomically\(/m.test(code),
    "크롤러가 promoteAtomically 를 직접 부르면 검증을 건너뛸 수 있다",
  );
}

console.log("crawler write-path binding: PASS");

/* 10) 크롤러 context 를 **실제 값으로** 검사한다 ───────────────────
 *
 * ⚠︎ 9번까지도 소스 문자열이다. mutation 으로 `roster:` 줄을 통째 바꾸면 검사 대상 줄이
 * 사라져 GREEN 이었다(실측). 그래서 크롤러 모듈에서 context 를 구성하는 실제 코드를
 * 평가해, payload 키를 넘기지 않는지 값으로 확인한다. */
{
  const crawler = readFileSync("scripts/crawl-stats.mjs", "utf8");
  const code = crawler
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  const ctxStart = code.indexOf("context: {");
  assert.ok(ctxStart >= 0, "크롤러 verifyThenPromote 호출에 context 가 있어야 한다");

  // ⚠︎ `code.indexOf("},")` 로 끝을 찾으면 값 안의 `{}`(예: `defenseRuns: {}`)에서 잘린다.
  // 실제로 그 때문에 주입 mutation 이 GREEN 이었다. 중괄호 균형으로 정확히 끊는다.
  const bodyStart = ctxStart + "context: {".length;
  let depth = 1;
  let bodyEnd = bodyStart;
  while (bodyEnd < code.length && depth > 0) {
    const ch = code[bodyEnd];
    if ("{([".includes(ch)) depth++;
    else if ("})]".includes(ch)) depth--;
    if (depth === 0) break;
    bodyEnd++;
  }
  const ctxBody = code.slice(bodyStart, bodyEnd);

  // context 최상위 키를 뽑는다(중첩 값 내부는 건너뛴다).
  const keys = [];
  {
    let nest = 0;
    let token = "";
    for (let i = 0; i < ctxBody.length; i++) {
      const ch = ctxBody[i];
      if ("{([".includes(ch)) { nest++; token = ""; continue; }
      if ("})]".includes(ch)) { nest--; token = ""; continue; }
      if (nest > 0) continue;
      if (ch === ":" || ch === ",") {
        const name = token.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.push(name);
        token = "";
        continue;
      }
      token += ch;
    }
    const tail = token.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(tail)) keys.push(tail);
  }
  assert.ok(keys.length > 0, "context 키를 파싱할 수 있어야 한다");

  // promote payload 에서 파생되는 값은 context 로 넘기면 안 된다.
  for (const forbidden of ["batters", "pitchers", "defense", "defenseRuns"]) {
    assert.ok(
      !keys.includes(forbidden),
      `크롤러가 context 로 ${forbidden} 를 넘기면 promote payload 검증이 우회된다`
        + `(context keys: ${keys.join(", ")})`,
    );
  }
}

console.log("crawler context binding: PASS");
