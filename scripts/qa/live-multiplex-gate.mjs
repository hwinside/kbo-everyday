#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SELFTEST = process.argv.includes("--selftest");
const ROOT = process.cwd();

let pass = 0;
let fail = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    return;
  }
  fail += 1;
  console.error(`  ✗ ${name}${detail ? ` (${detail})` : ""}`);
}

function read(path) {
  return readFileSync(path, "utf8");
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function assertTickCadence() {
  return import("../../src/lib/game/live-poll-stream.ts").then((mod) => {
    const liveSeq = Array.from({ length: 31 }, (_, i) => mod.shouldEmbedLive(i));
    const detailSeq = Array.from({ length: 31 }, (_, i) => mod.shouldEmbedDetail(i));
    const expectedLive = Array.from({ length: 31 }, (_, i) => i % 3 === 0);
    const expectedDetail = Array.from({ length: 31 }, (_, i) => i % 10 === 0);
    ok("tick/live cadence 0..30", JSON.stringify(liveSeq) === JSON.stringify(expectedLive));
    ok("tick/detail cadence 0..30", JSON.stringify(detailSeq) === JSON.stringify(expectedDetail));
    ok("tick/no per-poll live embed", liveSeq.filter(Boolean).length < liveSeq.length);
    ok("tick/no per-poll detail embed", detailSeq.filter(Boolean).length < detailSeq.length);
  });
}

function assertIncludeWiring() {
  const src = stripComments(read("src/lib/hooks/useGameRelay.ts"));
  ok("relay hook computes include from tick helpers",
    /const includeLive = isLive && shouldEmbedLive\(n\);[\s\S]*const includeDetail = isLive && shouldEmbedDetail\(n\);/.test(src));
  ok("relay hook sends include through combined endpoint",
    /if \(wantEvents \|\| include\.length > 0\)[\s\S]*fetch\(`\/api\/game-relay-events\?\$\{params\}`/.test(src));
  ok("relay hook preserves game-live date on multiplex",
    /params\.set\("date", resolveGameLiveDate\(requestGameId\)\);/.test(src));
  ok("relay hook forwards live\/detail frames with fencing callbacks",
    /else if \(envelope\.channel === "live"\)[\s\S]*options\?\.onLiveFrame[\s\S]*else if \(envelope\.channel === "detail"\)[\s\S]*options\?\.onDetailFrame/.test(src));
}

function assertRouteIncludeWiring() {
  const src = stripComments(read("src/app/api/game-relay-events/route.ts"));
  ok("route parses include allowlist", /function parseInclude\(req: NextRequest\)[\s\S]*trimmed === "live" \|\| trimmed === "detail"/.test(src));
  ok("route creates live task only when included",
    /if \(include\.has\("live"\)\)\s*\{\s*tasks\.push\(\{ channel: "live", task: getLive\(internalRequest\(req, "\/api\/game-live"\)\) \}\);\s*\}/.test(src));
  ok("route creates detail task only when included",
    /if \(include\.has\("detail"\)\)\s*\{\s*tasks\.push\(\{ channel: "detail", task: getDetail\(internalRequest\(req, "\/api\/game-detail"\)\) \}\);\s*\}/.test(src));
}

function assertSharedIngestPath() {
  const liveSrc = stripComments(read("src/lib/hooks/useLiveGame.ts"));
  const detailSrc = stripComments(read("src/lib/hooks/useGameDetail.ts"));
  ok("useLiveGame fetch and ingest share commit path",
    /commitPayloadRef\.current\s*=\s*\(payload, responseGeneration\)/.test(liveSrc)
      && /commitPayloadRef\.current\(\s*res\.ok \? data : \{ \.\.\.data, error: data\.error \|\| `HTTP \$\{res\.status\}` \},\s*responseGeneration,\s*\)/.test(liveSrc)
      && /const ingestExternal = useCallback\(\(payload: unknown\): void => \{[\s\S]*commitPayloadRef\.current\(\(payload \?\? \{\}\) as LiveGamePayload, responseGeneration\);/.test(liveSrc));
  ok("useGameDetail fetch and ingest share commit path",
    /commitPayloadRef\.current\s*=\s*\(json, responseGeneration\)/.test(detailSrc)
      && /commitPayloadRef\.current\(\s*res\.ok \? json : \{ \.\.\.json, error: json\.error \|\| `HTTP \$\{res\.status\}` \},\s*responseGeneration,\s*\)/.test(detailSrc)
      && /const ingestExternal = useCallback\(\(json: unknown\): void => \{[\s\S]*commitPayloadRef\.current\(\(json \?\? \{\}\) as GameDetailPayload, responseGeneration\);/.test(detailSrc));
  ok("useGameDetail pollInterval 0 disables visibility poller",
    /useVisibilityAwareInterval\([\s\S]*\{\s*enabled: pollInterval > 0,\s*resetKey: gameId\s*\},/.test(detailSrc));
}

function assertPageWiring() {
  const src = stripComments(read("src/app/(main)/games/[gameId]/page.tsx"));
  ok("page toggles multiplex from live state",
    /const \[multiplexActive, setMultiplexActive\] = useState\(false\);[\s\S]*setMultiplexActive\(liveGame\?\.isLive === true\);/.test(src));
  ok("page disables standalone live/detail polling during multiplex",
    /useLiveGame\(gameId, multiplexActive \? 0 : 10000\)/.test(src)
      && /useGameDetail\(gameId, multiplexActive \? 0 : 30000\)/.test(src));
  ok("page passes multiplex frames into hook ingest paths",
    /onLiveFrame: liveHook\.ingestExternal,\s*onDetailFrame: detailHook\.ingestExternal/.test(src));
}

function assertUntouchedFiles() {
  const untouched = [
    "src/lib/supabase/useChat.ts",
    "src/components/game/GameChat.tsx",
    "src/components/home/HomeClientShell.tsx",
  ];
  for (const file of untouched) {
    const result = spawnSync("git", ["diff", "--quiet", "--", file], { cwd: ROOT });
    ok(`${file} unchanged`, result.status === 0);
  }
}

function mutate(path, from, to) {
  const src = read(path);
  if (!src.includes(from)) throw new Error(`mutation target missing in ${path}`);
  writeFileSync(path, src.replace(from, to));
}

function runSelfTest() {
  const targetFiles = [
    "src/lib/game/live-poll-stream.ts",
    "src/lib/hooks/useGameRelay.ts",
    "src/app/api/game-relay-events/route.ts",
    "src/lib/hooks/useLiveGame.ts",
    "src/app/(main)/games/[gameId]/page.tsx",
  ];
  const cases = [
    {
      name: "tick cadence mutant",
      apply: () => mutate(
        "src/lib/game/live-poll-stream.ts",
        "return pollIndex % 3 === 0;",
        "return pollIndex % 3 !== 0;",
      ),
    },
    {
      name: "include wiring mutant",
      apply: () => mutate(
        "src/lib/hooks/useGameRelay.ts",
        "const includeLive = isLive && shouldEmbedLive(n);",
        "const includeLive = isLive;",
      ),
    },
    {
      name: "route conditional mutant",
      apply: () => mutate(
        "src/app/api/game-relay-events/route.ts",
        "if (include.has(\"live\")) {",
        "if (true) {",
      ),
    },
    {
      name: "shared ingest mutant",
      apply: () => mutate(
        "src/lib/hooks/useLiveGame.ts",
        "    commitPayloadRef.current((payload ?? {}) as LiveGamePayload, responseGeneration);\n",
        "    setError(payload.error || null);\n",
      ),
    },
    {
      name: "page multiplex interval mutant",
      apply: () => mutate(
        "src/app/(main)/games/[gameId]/page.tsx",
        "  const detailHook = useGameDetail(gameId, multiplexActive ? 0 : 30000);",
        "  const detailHook = useGameDetail(gameId, 30000);",
      ),
    },
  ];

  for (const testCase of cases) {
    const backups = new Map();
    try {
      for (const file of targetFiles) {
        backups.set(file, read(file));
      }
      testCase.apply();
      const child = spawnSync("npx", ["tsx", "scripts/qa/live-multiplex-gate.mjs"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      ok(`selftest ${testCase.name}`, child.status !== 0, child.stdout || child.stderr);
    } finally {
      for (const [file, original] of backups) writeFileSync(file, original);
    }
  }
}

async function main() {
  await assertTickCadence();
  assertIncludeWiring();
  assertRouteIncludeWiring();
  assertSharedIngestPath();
  assertPageWiring();
  assertUntouchedFiles();

  if (SELFTEST) runSelfTest();

  console.log(`live-multiplex-gate: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
