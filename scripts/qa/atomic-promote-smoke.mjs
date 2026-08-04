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

/* 6) 다음 promote 가 시작 시 자동으로 복구한다 (수동 호출에 의존하지 않는다) */
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

  // 복구를 따로 부르지 않고 바로 다음 promote 를 돌린다.
  // 시작 시 자동 복구되므로, 이번 promote 는 깨끗한 old 위에서 시작해 전부 new 가 된다.
  promoteAtomically(artifacts);
  for (const artifact of artifacts) {
    assert.equal(
      readFileSync(artifact.path, "utf8"),
      artifact.body,
      "자동 복구 후 재시도는 전 산출물을 새 세대로 교체해야 한다",
    );
    assert.notEqual(sha(artifact.path), before.get(artifact.path));
  }
  assert.equal(hasPendingPromotion(dir), false, "성공 후 저널은 남지 않아야 한다");
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

/* 5) 실제 배선 — 크롤러가 순차 직쓰기 대신 promoteAtomically 를 쓰는가 */
{
  const crawler = readFileSync("scripts/crawl-stats.mjs", "utf8");
  assert.ok(
    crawler.includes("promoteAtomically(artifacts)"),
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
