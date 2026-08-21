#!/usr/bin/env node
// 게이트 티어 러너 — Vercel 배포 병목 해소 (삼순 ⓑ 조건부 GO 기준 최소 설계)
//
// SSOT: scripts/qa/gate-tiers.json (게이트 172개 × tier=deploy|ci)
//       scripts/qa/gate-tiers-helpers.json (게이트가 아닌 qa:* 보조 스크립트 allowlist)
//
// 실행면:
//   --tier deploy        : Vercel prebuild — 배포마다 필수인 게이트만 (직렬)
//   --tier ci [--shard i/N] : GitHub Actions PR required check — 나머지 게이트 (샤드 분할 병렬)
//   --tier all           : nightly full — 172개 전체
//   --list               : 선택된 게이트 목록만 출력 (실행 없음)
//   --selftest           : 검증 로직 자체의 결함주입 selftest
//
// fail-close 계약:
//   1) manifest의 게이트가 package.json scripts에 없으면 실행 전 즉시 FAIL
//   2) gate-tiers.json에도 helpers에도 없는 qa:* 스크립트가 존재하면 즉시 FAIL
//      (새 게이트를 만들고 manifest 등록을 잊으면 여기서 잡힌다)
//   3) tier 값이 deploy|ci 외이거나 이름 중복이면 즉시 FAIL
//   4) 샤드 파라미터가 비정상(i>=N, N<1, 비정수)이면 즉시 FAIL
//   5) 게이트 하나라도 exit!=0 이면 그 자리에서 exit 1
// 병렬 프로세스 그룹/kill 로직 없음 — 전부 순차 spawnSync (환경 의존 제로).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

export const TIERS = ["deploy", "ci"];

export function validateManifest(manifest, helpers, pkgScripts) {
  const errors = [];
  const gates = manifest?.gates;
  if (!Array.isArray(gates) || gates.length === 0) {
    return ["manifest.gates 배열이 비어있거나 없음"];
  }
  const seen = new Set();
  for (const g of gates) {
    if (!g || typeof g.name !== "string" || !g.name.startsWith("qa:")) {
      errors.push(`잘못된 게이트 엔트리: ${JSON.stringify(g)}`);
      continue;
    }
    if (seen.has(g.name)) errors.push(`게이트 이름 중복: ${g.name}`);
    seen.add(g.name);
    if (!TIERS.includes(g.tier)) errors.push(`허용되지 않은 tier(${g.tier}): ${g.name}`);
    if (!(g.name in pkgScripts)) errors.push(`package.json scripts에 없는 게이트: ${g.name}`);
  }
  const helperSet = new Set(helpers?.helpers ?? []);
  for (const h of helperSet) {
    if (seen.has(h)) errors.push(`helpers와 gates에 동시 등재: ${h}`);
  }
  for (const scriptName of Object.keys(pkgScripts)) {
    if (!scriptName.startsWith("qa:")) continue;
    if (!seen.has(scriptName) && !helperSet.has(scriptName)) {
      errors.push(
        `미분류 qa:* 스크립트: ${scriptName} — gate-tiers.json(게이트) 또는 gate-tiers-helpers.json(보조)에 등록 필요`,
      );
    }
  }
  return errors;
}

export function selectGates(manifest, tier) {
  if (tier === "all") return manifest.gates.map((g) => g.name);
  return manifest.gates.filter((g) => g.tier === tier).map((g) => g.name);
}

export function parseShard(spec) {
  if (spec == null) return { index: 0, total: 1 };
  const m = /^([0-9]+)\/([0-9]+)$/.exec(spec);
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total)) return null;
  if (total < 1 || index < 0 || index >= total) return null;
  return { index, total };
}

export function shardSlice(names, shard) {
  return names.filter((_, i) => i % shard.total === shard.index);
}

function loadJson(rel) {
  return JSON.parse(readFileSync(path.join(repoRoot, rel), "utf8"));
}

function runGate(name, spawnImpl = spawnSync) {
  const started = Date.now();
  const res = spawnImpl("npm", ["run", name], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  return { ok: res.status === 0, sec, status: res.status };
}

function selftest() {
  const pkgScripts = { "qa:a": "x", "qa:b": "x", "qa:helper": "x" };
  const okMan = { gates: [{ name: "qa:a", tier: "deploy" }, { name: "qa:b", tier: "ci" }] };
  const okHelp = { helpers: ["qa:helper"] };
  const cases = [
    ["정상 manifest는 PASS", () => validateManifest(okMan, okHelp, pkgScripts).length === 0],
    [
      "M1 scripts에 없는 게이트 → FAIL",
      () =>
        validateManifest(
          { gates: [...okMan.gates, { name: "qa:ghost", tier: "deploy" }] },
          okHelp,
          pkgScripts,
        ).length > 0,
    ],
    [
      "M2 미분류 qa:* 스크립트 → FAIL",
      () => validateManifest(okMan, { helpers: [] }, pkgScripts).length > 0,
    ],
    [
      "M3 허용 외 tier → FAIL",
      () =>
        validateManifest(
          { gates: [{ name: "qa:a", tier: "sometimes" }, { name: "qa:b", tier: "ci" }] },
          okHelp,
          pkgScripts,
        ).length > 0,
    ],
    [
      "M4 게이트 이름 중복 → FAIL",
      () =>
        validateManifest(
          { gates: [{ name: "qa:a", tier: "deploy" }, { name: "qa:a", tier: "ci" }, { name: "qa:b", tier: "ci" }] },
          okHelp,
          pkgScripts,
        ).length > 0,
    ],
    [
      "M5 helpers·gates 동시 등재 → FAIL",
      () => validateManifest(okMan, { helpers: ["qa:a", "qa:helper"] }, pkgScripts).length > 0,
    ],
    [
      "M6 잘못된 샤드 spec → null",
      () =>
        parseShard("2/2") === null &&
        parseShard("0/0") === null &&
        parseShard("x/3") === null &&
        parseShard("-1/3") === null,
    ],
    [
      "M7 샤드 합집합 = 전체 & 교집합 없음",
      () => {
        const names = Array.from({ length: 23 }, (_, i) => `qa:g${i}`);
        const parts = [0, 1, 2].map((i) => shardSlice(names, { index: i, total: 3 }));
        const union = parts.flat();
        return union.length === names.length && new Set(union).size === names.length;
      },
    ],
    [
      "M8 게이트 실패 exit 전파",
      () => {
        const res = runGate("qa:fake", () => ({ status: 1 }));
        return res.ok === false && res.status === 1;
      },
    ],
    [
      "M9 실제 manifest/helpers/package.json 정합",
      () => {
        const errors = validateManifest(
          loadJson("scripts/qa/gate-tiers.json"),
          loadJson("scripts/qa/gate-tiers-helpers.json"),
          loadJson("package.json").scripts,
        );
        if (errors.length) console.error(errors.join("\n"));
        return errors.length === 0;
      },
    ],
  ];
  let failed = 0;
  for (const [label, fn] of cases) {
    let ok = false;
    try {
      ok = fn();
    } catch (e) {
      console.error(`  (예외) ${e?.message}`);
    }
    console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) {
    console.error(`[gate-tiers selftest] FAIL — ${failed}건`);
    process.exit(1);
  }
  console.log(`[gate-tiers selftest] PASS — ${cases.length}건`);
}

function main() {
  const argv = process.argv.slice(2);
  const canonical = new Set(["--tier", "--shard", "--list", "--selftest"]);
  for (const a of argv) {
    if (a.startsWith("--") && !canonical.has(a)) {
      // 값 인자(deploy, 0/3 등)는 -- 로 시작하지 않으므로 여기서 걸리지 않는다
      console.error(`[gate-tiers] 알 수 없는 플래그: ${a}`);
      process.exit(1);
    }
  }
  if (argv.includes("--selftest")) {
    selftest();
    return;
  }
  const tierIdx = argv.indexOf("--tier");
  const tier = tierIdx >= 0 ? argv[tierIdx + 1] : null;
  if (!tier || !["deploy", "ci", "all"].includes(tier)) {
    console.error("[gate-tiers] --tier deploy|ci|all 필수");
    process.exit(1);
  }
  const shardIdx = argv.indexOf("--shard");
  const shard = parseShard(shardIdx >= 0 ? argv[shardIdx + 1] : null);
  if (shard === null) {
    console.error("[gate-tiers] --shard i/N 형식 오류 (0<=i<N)");
    process.exit(1);
  }
  if (shardIdx >= 0 && tier !== "ci") {
    console.error("[gate-tiers] --shard는 --tier ci에서만 허용");
    process.exit(1);
  }

  // fail-close 검증 — 실행 전
  const manifest = loadJson("scripts/qa/gate-tiers.json");
  const helpers = loadJson("scripts/qa/gate-tiers-helpers.json");
  const pkg = loadJson("package.json");
  const errors = validateManifest(manifest, helpers, pkg.scripts);
  if (errors.length) {
    console.error(`[gate-tiers] manifest 검증 실패 (fail-close):\n${errors.join("\n")}`);
    process.exit(1);
  }

  const selected = shardSlice(selectGates(manifest, tier), shard);
  console.log(
    `[gate-tiers] tier=${tier} shard=${shard.index}/${shard.total} — ${selected.length}개 게이트`,
  );
  if (argv.includes("--list")) {
    for (const name of selected) console.log(name);
    return;
  }
  const started = Date.now();
  let done = 0;
  for (const name of selected) {
    const res = runGate(name);
    done += 1;
    if (!res.ok) {
      console.error(`[gate-tiers] FAIL — ${name} (exit=${res.status}, ${res.sec}s, ${done}/${selected.length})`);
      process.exit(1);
    }
    console.log(`[gate-tiers] ok ${name} ${res.sec}s (${done}/${selected.length})`);
  }
  const totalSec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[gate-tiers] PASS — ${selected.length}/${selected.length}, ${totalSec}s`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
