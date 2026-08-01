/**
 * backfill 진입점(.mts)의 모듈 로딩 회귀.
 *
 * 사고: run 30655482859 은
 *   SyntaxError: The requested module '@/lib/game-logs/completeness'
 *                does not provide an export named 'buildGameIngestion'
 * 로 죽었다. 코드 문제가 아니라 러너 node 버전 문제였다 —
 * lockfile 의 tsx 4.22.0 은 node 22 에서 .mts(ESM) 진입점이 CJS 로 컴파일된 .ts 모듈의
 * named export 를 인식하지 못한다. node 24 에서는 정상이다(양쪽 로컬 실측).
 *
 * 이 가드는 두 가지를 본다.
 *  1) 워크플로가 node >= 24 를 선언하는가 (버전 되돌림 차단)
 *  2) 진입점이 import 하는 named 바인딩이 실제로 로딩되는가 (export 이름 변경/삭제 차단)
 *
 * 2번은 진입점을 직접 import 하지 않는다 — 그 파일은 import 시 main() 이 실행돼
 * 네트워크/DB 를 탄다. 대신 import 문만 그대로 추출한 probe 를 만들어 실행한다.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const WORKFLOW = ".github/workflows/backfill-game-log-ledger.yml";
const ENTRY = "scripts/backfill-game-log-ledger.mts";
const MIN_NODE_MAJOR = 24;

let pass = 0;
let fail = 0;
const ok = (m) => {
  console.log(`  ✓ ${m}`);
  pass++;
};
const bad = (m) => {
  console.log(`  ✗ ${m}`);
  fail++;
};

console.log("[backfill module load] 진입점 로딩 가드");

// ── 1) 워크플로 node 버전 ─────────────────────────────────────────────────
const doc = yaml.load(readFileSync(WORKFLOW, "utf8"));
const setupNode = doc.jobs?.backfill?.steps?.find((s) =>
  String(s.uses ?? "").startsWith("actions/setup-node"),
);
if (!setupNode) {
  bad(`${WORKFLOW}: actions/setup-node step 을 찾지 못함`);
} else {
  const declared = String(setupNode.with?.["node-version"] ?? "");
  const major = Number.parseInt(declared, 10);
  if (!Number.isFinite(major)) {
    bad(`${WORKFLOW}: node-version 을 해석할 수 없음 ('${declared}')`);
  } else if (major < MIN_NODE_MAJOR) {
    bad(
      `${WORKFLOW}: node-version '${declared}' — ${MIN_NODE_MAJOR} 미만은 tsx 가 .mts→.ts named export 를 못 읽어 SyntaxError 로 죽는다 (run 30655482859)`,
    );
  } else {
    ok(`워크플로 node-version '${declared}' (>= ${MIN_NODE_MAJOR})`);
  }
}

// ── 2) 진입점 import 바인딩 실제 로딩 ──────────────────────────────────────
const source = readFileSync(ENTRY, "utf8");
// `import { a, b } from "x";` 형태만 본다 — 이 사고의 실패면이 named import 다.
const importRe = /^import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?\s*$/gm;
const specs = [];
for (const m of source.matchAll(importRe)) {
  const names = m[1]
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  if (names.length > 0) specs.push({ names, from: m[2] });
}

if (specs.length === 0) {
  bad(`${ENTRY}: named import 를 하나도 찾지 못함 — 파서가 낡았을 수 있다`);
} else {
  const dir = mkdtempSync(join(tmpdir(), "backfill-probe-"));
  // tsconfig paths(@/…) 를 타야 하므로 repo 안에 둔다.
  const probePath = `scripts/qa/.backfill-module-probe.mts`;
  const lines = [
    ...specs.map((s) => `import { ${s.names.join(", ")} } from ${JSON.stringify(s.from)};`),
    `const bindings = { ${specs.flatMap((s) => s.names).join(", ")} };`,
    `const missing = Object.entries(bindings).filter(([, v]) => v === undefined).map(([k]) => k);`,
    `if (missing.length > 0) { console.error("MISSING:" + missing.join(",")); process.exit(1); }`,
    `console.log("LOADED:" + Object.keys(bindings).join(","));`,
  ];
  writeFileSync(probePath, lines.join("\n") + "\n");
  try {
    const res = spawnSync("npx", ["tsx", probePath], {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        // 일부 모듈은 import 시점에 createClient 를 불러 env 를 요구한다.
        // 이 probe 는 **로딩만** 본다 — 네트워크/DB 호출은 없으므로
        // 도달 불가 주소를 넣어 실수로도 운영 DB 를 만지지 않게 한다.
        NEXT_PUBLIC_SUPABASE_URL:
          process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:1/module-load-probe",
        NEXT_PUBLIC_SUPABASE_ANON_KEY:
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "module-load-probe",
        SUPABASE_SERVICE_ROLE_KEY:
          process.env.SUPABASE_SERVICE_ROLE_KEY ?? "module-load-probe",
      },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.status === 0 && out.includes("LOADED:")) {
      ok(
        `진입점 named import ${specs.flatMap((s) => s.names).length}개 로딩 성공 (node ${process.version})`,
      );
    } else {
      bad(`진입점 import 로딩 실패 (node ${process.version}, exit ${res.status})`);
      console.log(
        out
          .split("\n")
          .filter(Boolean)
          .slice(0, 6)
          .map((l) => `      ${l}`)
          .join("\n"),
      );
    }
  } finally {
    rmSync(probePath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
