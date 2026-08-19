#!/usr/bin/env node
/**
 * 외부 cleanup selftest — "mutation 후 강제 예외/종료 → 전 대상 byte-identical" (삼순 4차 NO-GO).
 * 게이트 자신이 아니라 부모 프로세스가 판정한다: 게이트를 죽이고 나서 워킹트리를 검사한다.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const TARGETS = [
  "src/lib/services/player-today-game.ts",
  "src/app/api/widget/player-card/route.ts",
  "src/lib/services/player-stats.ts",
  "src/app/api/player-today-game/route.ts",
  "src/app/api/game-detail/route.ts",
  "src/app/api/player-stats/route.ts",
  "src/app/api/stats/route.ts",
  "src/app/api/player-game-logs/route.ts",
];
const snap = () => Object.fromEntries(
  TARGETS.map((f) => [f, createHash("sha256").update(readFileSync(f)).digest("hex")]),
);

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
let ok = true;
for (const mode of ["throw", "exit", "sigint", "sigterm"]) {
  const { out, code, sig } = await run(mode);
  const mutated = /PROBE_MUTATED/.test(out);
  const after = snap();
  const dirty = TARGETS.filter((f) => before[f] !== after[f]);
  const pass = mutated && dirty.length === 0;
  if (!pass) ok = false;
  console.log(
    `${pass ? "PASS" : "FAIL"} — ${mode}: mutation_applied=${mutated} exit=${code ?? sig} residue=${dirty.length}` +
    (dirty.length ? ` → ${dirty.join(", ")}` : ""),
  );
  if (!mutated) console.log("  (변이 미적용 — 이 회차는 아무것도 증명하지 않는다)");
}
console.log(ok ? "cleanup-selftest PASS — 4개 이탈 경로 전부 잔재 0" : "cleanup-selftest FAIL");
process.exit(ok ? 0 : 1);
