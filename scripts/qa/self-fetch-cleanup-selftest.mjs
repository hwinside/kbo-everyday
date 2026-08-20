#!/usr/bin/env node
/**
 * 외부 cleanup selftest — "mutation 후 강제 예외/종료 → 전 대상 byte-identical" (삼순 4차 NO-GO).
 * 게이트 자신이 아니라 부모 프로세스가 판정한다: 게이트를 죽이고 나서 워킹트리를 검사한다.
 *
 * 대상 목록은 게이트와 같은 SSOT(self-fetch-mutation-targets.mjs)를 쓴다 — 목록을 복제하면
 * 새 mutation target 을 한쪽에만 추가하는 순간 list drift 가 생기고, 그게 이번 사고의 형태다.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MUTATION_TARGETS as TARGETS } from "./self-fetch-mutation-targets.mjs";

const snap = () => Object.fromEntries(
  TARGETS.map((f) => [f, createHash("sha256").update(readFileSync(f)).digest("hex")]),
);

/** 게이트가 만드는 백업 temp 디렉토리 — 이탈 경로에서도 새지 않아야 한다. */
const tempBackups = () => {
  try {
    return readdirSync(tmpdir()).filter((n) => n.startsWith("self-fetch-internal-gate-"));
  } catch {
    return [];
  }
};

function run(mode) {
  return new Promise((resolve) => {
    const child = spawn("node", ["scripts/qa/self-fetch-internal-gate.mjs", "--selftest", `--cleanup-probe=${mode}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let signalled = false;
    const maybeSignal = () => {
      if (signalled) return;
      if (!/PROBE_MUTATED/.test(out)) return;
      signalled = true;
      // 변이가 실제로 적용된 뒤에만 죽인다 — 적용 전 종료는 아무것도 증명하지 않는다.
      child.kill(mode === "sigint" ? "SIGINT" : "SIGTERM");
    };
    child.stdout.on("data", (d) => { out += d; if (mode === "sigint" || mode === "sigterm") maybeSignal(); });
    child.stderr.on("data", (d) => { out += d; });
    child.on("exit", (code, sig) => resolve({ out, code, sig }));
  });
}

const before = snap();
const tempBefore = new Set(tempBackups());
let ok = true;

// 6번째 경로: 복원 실패 주입(restore-fail) — 삼순 #1257 5차 잔여 조건.
// 계약: cleanup()=false → exit 1, backupDir(복구 원본) **보존**, tracked source 전수 무결.
// 이 회차만은 temp 잔존이 누수가 아니라 계약이다 — 검증 후 부모가 직접 정리한다.
{
  const { out, code } = await run("restore-fail");
  const mutated = /PROBE_MUTATED/.test(out);
  const contract = /RESTORE_FAIL_PROBE cleanedUp=false backupDirPreserved=true backupIntact=true/.test(out);
  const after = snap();
  const dirty = TARGETS.filter((f) => before[f] !== after[f]);
  const preserved = tempBackups().filter((n) => !tempBefore.has(n));
  const pass = mutated && contract && code === 1 && dirty.length === 0 && preserved.length >= 1;
  if (!pass) ok = false;
  console.log(
    `${pass ? "PASS" : "FAIL"} — restore-fail: mutation_applied=${mutated} contract=${contract} ` +
    `exit=${code} residue=${dirty.length} backup_preserved=${preserved.length >= 1}`,
  );
  if (!mutated) console.log("  (변이 미적용 — 이 회차는 아무것도 증명하지 않는다)");
  // 보존 확인을 마친 뒤 부모가 정리 — 다음 회차의 temp_leak 판정 오염 방지.
  for (const n of preserved) rmSync(join(tmpdir(), n), { recursive: true, force: true });
}

for (const mode of ["throw", "exit", "sigint", "sigterm"]) {
  const { out, code, sig } = await run(mode);
  const mutated = /PROBE_MUTATED/.test(out);
  const after = snap();
  const dirty = TARGETS.filter((f) => before[f] !== after[f]);
  const leaked = tempBackups().filter((n) => !tempBefore.has(n));
  const pass = mutated && dirty.length === 0 && leaked.length === 0;
  if (!pass) ok = false;
  console.log(
    `${pass ? "PASS" : "FAIL"} — ${mode}: mutation_applied=${mutated} exit=${code ?? sig} ` +
    `residue=${dirty.length} temp_leak=${leaked.length}` +
    (dirty.length ? ` → ${dirty.join(", ")}` : "") +
    (leaked.length ? ` → temp ${leaked.join(", ")}` : ""),
  );
  if (!mutated) console.log("  (변이 미적용 — 이 회차는 아무것도 증명하지 않는다)");
}

// 정상 경로(프로브 없이 전체 selftest)도 temp 를 남기지 않는지 본다 — 삼순 지적:
// 정상 process.exit 이 outer rmSync 를 건너뛰어 backup 이 매번 남던 경로.
const normal = await new Promise((resolve) => {
  const child = spawn("node", ["scripts/qa/self-fetch-internal-gate.mjs", "--selftest"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("exit", (code) => resolve({ out, code }));
});
const normalLeak = tempBackups().filter((n) => !tempBefore.has(n));
const normalDirty = TARGETS.filter((f) => before[f] !== snap()[f]);
const normalPass = normal.code === 0 && normalLeak.length === 0 && normalDirty.length === 0;
if (!normalPass) ok = false;
console.log(
  `${normalPass ? "PASS" : "FAIL"} — normal: exit=${normal.code} ` +
  `residue=${normalDirty.length} temp_leak=${normalLeak.length}` +
  (normalLeak.length ? ` → temp ${normalLeak.join(", ")}` : ""),
);

console.log(ok ? "cleanup-selftest PASS — 6개 경로(restore-fail/throw/exit/sigint/sigterm/normal) 잔재 0 · 복원실패 fail-close · temp 누수 0" : "cleanup-selftest FAIL");
process.exit(ok ? 0 : 1);
