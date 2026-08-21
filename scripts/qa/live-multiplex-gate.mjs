#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SELFTEST = process.argv.includes("--selftest");
const ROOT = process.cwd();
const CHAT_BASE_DIFF_PATHS = [
  "src/lib/supabase/useChat.ts",
  "src/components/game/GameChat.tsx",
  "src/components/game/LiveChat.tsx",
  "src/app/api/admin/today-detail/route.ts",
  "src/app/api/admin/supabase-usage/route.ts",
  "src/app/api/admin/content/route.ts",
  "src/app/api/admin/reports/route.ts",
  "src/app/api/contextual-stats/route.ts",
  "src/app/api/report/route.ts",
  "src/app/api/slack/gif-collector/route.ts",
  "src/app/api/game-chat/prefs/route.ts",
  "src/app/api/venue-stories/attendees/route.ts",
  "src/app/api/cron/daily-fallback-report/route.ts",
];

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

function hasOriginMainRef(spawn = spawnSync) {
  const result = spawn("git", ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], { cwd: ROOT });
  return result.status === 0;
}

function makeBaseHeadDiffQuiet(spawn = spawnSync) {
  return (base, path) => spawn("git", ["diff", "--quiet", base, "HEAD", "--", path], { cwd: ROOT }).status;
}

function evaluateBaseHeadChanges(
  paths,
  {
    baseRef = hasOriginMainRef() ? spawnSync("git", ["merge-base", "origin/main", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim() : null,
    diffQuiet = makeBaseHeadDiffQuiet(),
  } = {},
) {
  if (!baseRef) {
    return { ok: false, reason: "origin/main missing", changed: [] };
  }
  const changed = [];
  for (const path of paths) {
    const status = diffQuiet(baseRef, path);
    if (status === 1) changed.push(path);
    else if (status !== 0) {
      return { ok: false, reason: `git diff failed for ${path} (${status})`, changed: [] };
    }
  }
  return { ok: true, changed, reason: null };
}

function assertTickCadence() {
  return import("../../src/lib/game/live-poll-stream.ts").then((mod) => {
    const intervalMs = 3000;
    const indices = Array.from({ length: 20 }, (_, i) => i);
    const liveSeq = indices.map((i) => mod.shouldEmbedLive(i, intervalMs));
    const detailSeq = indices.map((i) => mod.shouldEmbedDetail(i, intervalMs));
    const includeSeq = indices.map((i) => mod.buildIncludeChannels({
      pollIndex: i,
      isLive: true,
      isFinal: false,
    }));
    ok("tick/live cadence 0..19", JSON.stringify(liveSeq) === JSON.stringify(indices.map((i) => [0, 3, 6, 9, 12, 15, 18].includes(i))));
    ok("tick/detail cadence 0..19", JSON.stringify(detailSeq) === JSON.stringify(indices.map((i) => [0, 10].includes(i))));
    ok("tick/events cadence 0..19", JSON.stringify(includeSeq.map((include) => include.includes("events"))) === JSON.stringify(indices.map((i) => [0, 5, 10, 15].includes(i))));
    ok("tick/live count in 60s window", liveSeq.filter(Boolean).length === 7);
    ok("tick/detail count in 60s window", detailSeq.filter(Boolean).length === 2);
    ok("tick/events count in 60s window", includeSeq.filter((include) => include.includes("events")).length === 4);
  });
}

function assertIncludeWiring() {
  const src = stripComments(read("src/lib/hooks/useGameRelay.ts"));
  ok(
    "relay hook delegates include SSOT to buildIncludeChannels",
    /const forceEmbed = opts\?\.forceEmbed === true;[\s\S]*const include = buildIncludeChannels\(\{[\s\S]*pollIndex: n,[\s\S]*isLive,[\s\S]*isFinal,[\s\S]*forceEmbed,[\s\S]*\}\);[\s\S]*wantEvents = include\.includes\("events"\);/.test(src),
  );
  ok(
    "relay hook visibility resume force-embeds live/detail in one request",
    /if \(document\.visibilityState === "visible"\) fetchRelay\(undefined, \{ forceEmbed: true \}\);/.test(src),
  );
  ok(
    "relay hook sends include through combined endpoint",
    /if \(include\.length > 0\)[\s\S]*fetch\(`\/api\/game-relay-events\?\$\{params\}`/.test(src),
  );
  ok(
    "relay hook preserves game-live date on multiplex",
    /params\.set\("date", resolveGameLiveDate\(requestGameId\)\);/.test(src),
  );
}

function assertFrameFencing() {
  const src = stripComments(read("src/lib/hooks/useGameRelay.ts"));
  ok("relay hook defines per-channel owner seq refs",
    /const liveFrameOwnerSeqRef = useRef\(0\);[\s\S]*const detailFrameOwnerSeqRef = useRef\(0\);/.test(src));
  ok("relay hook applies frame only when channel seq increases for active game",
    /!\s*mountedRef\.current[\s\S]*activeGameIdRef\.current !== requestGameId[\s\S]*mySeq <= channelRef\.current[\s\S]*channelRef\.current = mySeq;[\s\S]*onFrame\(data\);/.test(src));
  ok("relay hook resets channel owner seq refs on game switch",
    /liveFrameOwnerSeqRef\.current = 0;[\s\S]*detailFrameOwnerSeqRef\.current = 0;/.test(src));
  ok("relay hook forwards live\/detail frames through channel refs",
    /applyFrame\(liveFrameOwnerSeqRef, options\?\.onLiveFrame, envelope\.data\);[\s\S]*applyFrame\(detailFrameOwnerSeqRef, options\?\.onDetailFrame, envelope\.data\);/.test(src));
  ok("relay frame fencing remains on shouldApplyRelayResponse",
    /if \(shouldApplyRelayResponse\(\{[\s\S]*requestSeq: mySeq,[\s\S]*currentSeq: requestSeqRef\.current/.test(src));
}

function assertRouteIncludeWiring() {
  const src = stripComments(read("src/app/api/game-relay-events/route.ts"));
  ok("route parses include allowlist", /function parseInclude\(req: NextRequest\)[\s\S]*trimmed === "events" \|\| trimmed === "live" \|\| trimmed === "detail"/.test(src));
  ok("route creates events task only when included or include is absent",
    /const rawInclude = req\.nextUrl\.searchParams\.get\("include"\);[\s\S]*if \(rawInclude === null \|\| include\.has\("events"\)\)\s*\{\s*tasks\.push\(\{ channel: "events", task: getEvents\(internalRequest\(req, "\/api\/game-events"\)\) \}\);\s*\}/.test(src));
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

function assertChatGateBaseDiff() {
  ok("chat gate path list includes transport files",
    CHAT_BASE_DIFF_PATHS.includes("src/lib/supabase/useChat.ts")
    && CHAT_BASE_DIFF_PATHS.includes("src/components/game/GameChat.tsx")
    && CHAT_BASE_DIFF_PATHS.includes("src/components/game/LiveChat.tsx")
    && CHAT_BASE_DIFF_PATHS.includes("src/app/api/game-chat/prefs/route.ts"));

  const clean = evaluateBaseHeadChanges(["fixture-a"], {
    baseRef: "base",
    diffQuiet: () => 0,
  });
  ok("chat gate injected clean diff stays green", clean.ok && clean.changed.length === 0);

  const dirty = evaluateBaseHeadChanges(["fixture-a"], {
    baseRef: "base",
    diffQuiet: () => 1,
  });
  ok("chat gate injected base...HEAD diff turns red", dirty.ok && dirty.changed[0] === "fixture-a");

  const missing = evaluateBaseHeadChanges(["fixture-a"], {
    baseRef: null,
    diffQuiet: () => 0,
  });
  ok("chat gate fails closed without origin/main", missing.ok === false && missing.reason === "origin/main missing");

  let capturedArgs = null;
  makeBaseHeadDiffQuiet((cmd, args) => {
    capturedArgs = { cmd, args };
    return { status: 0 };
  })("base-sha", "fixture-a");
  ok("chat gate default diff uses merge-base...HEAD path fence",
    capturedArgs?.cmd === "git"
    && JSON.stringify(capturedArgs.args) === JSON.stringify(["diff", "--quiet", "base-sha", "HEAD", "--", "fixture-a"]));
}

function assertUntouchedFiles() {
  const diff = evaluateBaseHeadChanges(CHAT_BASE_DIFF_PATHS);
  ok("chat base-diff gate resolved origin/main", diff.ok, diff.reason ?? "");
  ok("chat transport untouched vs merge-base", diff.ok && diff.changed.length === 0, diff.changed.join(", "));
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
    "scripts/qa/live-multiplex-gate.mjs",
    "src/app/api/game-relay-events/route.ts",
    "src/lib/hooks/useLiveGame.ts",
    "src/app/(main)/games/[gameId]/page.tsx",
  ];
  const cases = [
    {
      name: "global seq frame mutant",
      apply: () => mutate(
        "src/lib/hooks/useGameRelay.ts",
        "            || mySeq <= channelRef.current\n",
        "            || mySeq !== requestSeqRef.current\n",
      ),
    },
    {
      name: "forceEmbed resume mutant",
      apply: () => mutate(
        "src/lib/hooks/useGameRelay.ts",
        "        if (document.visibilityState === \"visible\") fetchRelay(undefined, { forceEmbed: true });\n",
        "        if (document.visibilityState === \"visible\") fetchRelay();\n",
      ),
    },
    {
      name: "12s total-preserving live cadence mutant",
      apply: () => mutate(
        "src/lib/game/live-poll-stream.ts",
        "  return pollIndex % 3 === 0;\n",
        "  return ((pollIndex * _intervalMs) % 10_000) < _intervalMs;\n",
      ),
    },
    {
      name: "events always-on combined mutant",
      apply: () => mutate(
        "src/app/api/game-relay-events/route.ts",
        "  if (rawInclude === null || include.has(\"events\")) {\n    tasks.push({ channel: \"events\", task: getEvents(internalRequest(req, \"/api/game-events\")) });\n  }\n",
        "  tasks.push({ channel: \"events\", task: getEvents(internalRequest(req, \"/api/game-events\")) });\n",
      ),
    },
    {
      name: "worktree-only diff mutant",
      apply: () => mutate(
        "scripts/qa/live-multiplex-gate.mjs",
        "  return (base, path) => spawn(\"git\", [\"diff\", \"--quiet\", base, \"HEAD\", \"--\", path], { cwd: ROOT }).status;\n",
        "  return (_base, path) => spawn(\"git\", [\"diff\", \"--quiet\", \"--\", path], { cwd: ROOT }).status;\n",
      ),
    },
  ];

  for (const testCase of cases) {
    const backups = new Map();
    try {
      for (const file of targetFiles) backups.set(file, read(file));
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
  assertFrameFencing();
  assertRouteIncludeWiring();
  assertSharedIngestPath();
  assertPageWiring();
  assertChatGateBaseDiff();
  assertUntouchedFiles();

  if (SELFTEST) runSelfTest();

  console.log(`live-multiplex-gate: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
