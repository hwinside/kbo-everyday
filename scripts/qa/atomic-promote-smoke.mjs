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
import { promoteAtomically } from "../lib/atomic-promote.mjs";

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
