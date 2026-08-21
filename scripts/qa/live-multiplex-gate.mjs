#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

// Vercel 빌드는 shallow single-branch clone이라 refs/remotes/origin/main이 없다.
// 그 환경에서 chat base-diff 축이 false-RED로 배포를 죽였다(1afb4643a 실측).
// fallback 1: origin/main을 depth-1로 fetch해 FETCH_HEAD 기준 diff.
// fallback 2(네트워크/자격 불가): merge-base 시점 채팅 transport 파일의 sha256 핀과
// 워킹트리 해시를 대조 — 불일치는 fail-close(진짜 변경이든 stale 핀이든 사람이 봐야 한다).
// 핀 갱신: 채팅 파일을 정당하게 바꾸는 PR이 이 표를 같은 PR에서 갱신한다.
// 계약: 핀 집합은 CHAT_BASE_DIFF_PATHS 와 정확히 같아야 한다(set equality — 부분 핀은 fail-open이라 금지,
// 게이트 시작 시점에 항상 검사하므로 핀 누락/윴여는 fallback 경로와 무관하게 즉시 RED).
const CHAT_TRANSPORT_SHA256 = {
  "src/lib/supabase/useChat.ts": "1a3253dfb9bb01c94ddd820673661c2f6ac226c97e9887932904c0a24b388548",
  "src/components/game/GameChat.tsx": "5a3fba682abf496fa2df2e0425d2ade1cfdeaa4bf0e4f71bb22439e892cb4bcc",
  "src/components/game/LiveChat.tsx": "7bd019886e682c9d930729b25ee99dec780109ec4f1a85fb21d8217a9496548c",
  "src/app/api/admin/today-detail/route.ts": "206e50ea9ec78992179ed061f91da473913fd8ae09a685b0c617e24d2e8bc10b",
  "src/app/api/admin/supabase-usage/route.ts": "4db90091a59b99da9dc3d1e0937359a4ab1da4f752addf41756ef4c07e0decb5",
  "src/app/api/admin/content/route.ts": "b1d1ecf0e8a8474485561fd8f09f11a7eda2433c1b5d6b657e66487749ccab02",
  "src/app/api/admin/reports/route.ts": "990c3a42e40c337d45f1ac7023efc339a4562036fd4ae775d8e3a9b678e7f442",
  "src/app/api/contextual-stats/route.ts": "81d430b3a0af4e01261a8e1de8f2e8206713a2af363b6e4f53b42f5490674b77",
  "src/app/api/report/route.ts": "7162fc6bde6e7ea2747c7877281ccf0857b05eded5d409d24ab5e02608986bf3",
  "src/app/api/slack/gif-collector/route.ts": "155483260ced25cacfa3132a6c4305fc0a86f6eafd5b2aae722f2523d8a0e9d4",
  "src/app/api/game-chat/prefs/route.ts": "036a254346d128c5d12574a66f56b69864a578674b4edfbebb2abb8d827f320d",
  "src/app/api/venue-stories/attendees/route.ts": "e1c21c12d3ce1bbfc25b0f2cb17ef2b6ccb7cbf0cca531bfb1ad055f9d05552a",
  "src/app/api/cron/daily-fallback-report/route.ts": "d598b2bd32d335810e1303f903359258b20efe63cdec69167e16edd2fd6a0b95",
};

// path set === pin set 계약 — fallback 발동 여부와 무관하게 항상 검사한다.
function evaluatePinSetEquality(paths = CHAT_BASE_DIFF_PATHS, pins = CHAT_TRANSPORT_SHA256) {
  const pathSet = new Set(paths);
  const pinSet = new Set(Object.keys(pins));
  const missingPins = [...pathSet].filter((p) => !pinSet.has(p));
  const orphanPins = [...pinSet].filter((p) => !pathSet.has(p));
  return { ok: missingPins.length === 0 && orphanPins.length === 0, missingPins, orphanPins };
}

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(`${ROOT}/${path}`)).digest("hex");
}

function tryFetchOriginMain(spawn = spawnSync) {
  const fetched = spawn(
    "git",
    ["fetch", "--no-tags", "--depth=1", "origin", "main"],
    { cwd: ROOT },
  );
  if (fetched.status !== 0) return null;
  const head = spawn("git", ["rev-parse", "--verify", "FETCH_HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (head.status !== 0) return null;
  return head.stdout.trim();
}

function evaluatePinnedChatHashes({ hashOf = sha256OfFile, pins = CHAT_TRANSPORT_SHA256 } = {}) {
  const mismatched = [];
  for (const [path, expected] of Object.entries(pins)) {
    let actual;
    try {
      actual = hashOf(path);
    } catch {
      mismatched.push(`${path} (unreadable)`);
      continue;
    }
    if (actual !== expected) mismatched.push(path);
  }
  return { ok: mismatched.length === 0, mismatched };
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
    /!\s*mountedRef\.current[\s\S]*activeGameIdRef\.current !== requestGameId[\s\S]*mySeq <= channelRef\.current[\s\S]*channelRef\.current = mySeq;[\s\S]*onFrame\(envelope\.data\);/.test(src));
  // 삼순 6차: 실패 frame fail-open 차단 — envelope.ok 아니면 seq 미소유 + 미커밋(last-good 보존).
  ok("relay hook drops failed live/detail frames before seq ownership (envelope.ok gate)",
    /if \(!envelope\.ok\) return;[\s\S]*if \(mySeq <= channelRef\.current\) return;[\s\S]*channelRef\.current = mySeq;[\s\S]*onFrame\(envelope\.data\);/.test(src));
  ok("relay hook resets channel owner seq refs on game switch",
    /liveFrameOwnerSeqRef\.current = 0;[\s\S]*detailFrameOwnerSeqRef\.current = 0;/.test(src));
  ok("relay hook forwards live\/detail frames through channel refs",
    /applyFrame\(liveFrameOwnerSeqRef, options\?\.onLiveFrame, envelope\);[\s\S]*applyFrame\(detailFrameOwnerSeqRef, options\?\.onDetailFrame, envelope\);/.test(src));
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

  // —— pin 계약 mutant (삼순 4차 NO-GO: 부분 핀 fail-open 검출력 증명) ——
  const fullPins = evaluatePinSetEquality();
  ok("pin contract: 현재 핀은 path 집합과 정확히 일치", fullPins.ok,
    [...fullPins.missingPins, ...fullPins.orphanPins].join(", "));

  const omittedPins = { ...CHAT_TRANSPORT_SHA256 };
  delete omittedPins[CHAT_BASE_DIFF_PATHS[3]];
  const omitted = evaluatePinSetEquality(CHAT_BASE_DIFF_PATHS, omittedPins);
  ok("pin mutant RED: 핀 1개 누락(omitted) 즉시 검출",
    omitted.ok === false && omitted.missingPins.length === 1 && omitted.missingPins[0] === CHAT_BASE_DIFF_PATHS[3]);

  const orphan = evaluatePinSetEquality(CHAT_BASE_DIFF_PATHS.slice(0, 12), CHAT_TRANSPORT_SHA256);
  ok("pin mutant RED: path 목록에 없는 윴여 핀(orphan) 즉시 검출",
    orphan.ok === false && orphan.orphanPins.length === 1);

  const mismatch = evaluatePinnedChatHashes({
    hashOf: (p) => (p === CHAT_BASE_DIFF_PATHS[0] ? "deadbeef" : CHAT_TRANSPORT_SHA256[p]),
  });
  ok("pin mutant RED: hash mismatch 즉시 검출(fail-close)",
    mismatch.ok === false && mismatch.mismatched.length === 1 && mismatch.mismatched[0] === CHAT_BASE_DIFF_PATHS[0]);

  const unreadable = evaluatePinnedChatHashes({
    hashOf: (p) => { if (p === CHAT_BASE_DIFF_PATHS[1]) throw new Error("gone"); return CHAT_TRANSPORT_SHA256[p]; },
  });
  ok("pin mutant RED: 파일 unreadable 즉시 검출(fail-close)",
    unreadable.ok === false && unreadable.mismatched.some((m) => m.includes("unreadable")));

  const allPinsClean = evaluatePinnedChatHashes();
  ok("pin base GREEN: 워킹트리 13개 전부 핀과 일치", allPinsClean.ok, allPinsClean.mismatched.join(", "));
}

function assertUntouchedFiles({
  evalBase = evaluateBaseHeadChanges,
  fetchBase = tryFetchOriginMain,
  evalPins = evaluatePinnedChatHashes,
  report = ok,
} = {}) {
  const pinContract = evaluatePinSetEquality();
  report(
    "chat pin set === base-diff path set (fail-open 방지 계약)",
    pinContract.ok,
    [
      pinContract.missingPins.length ? `missing pins: ${pinContract.missingPins.join(", ")}` : "",
      pinContract.orphanPins.length ? `orphan pins: ${pinContract.orphanPins.join(", ")}` : "",
    ].filter(Boolean).join(" / "),
  );
  let diff = evalBase(CHAT_BASE_DIFF_PATHS);
  if (!diff.ok && diff.reason === "origin/main missing") {
    const fetchedBase = fetchBase();
    if (fetchedBase) {
      diff = evalBase(CHAT_BASE_DIFF_PATHS, { baseRef: fetchedBase });
    } else {
      const pinned = evalPins();
      report(
        "chat transport untouched (pinned-hash fallback — shallow clone, fetch unavailable)",
        pinned.ok,
        pinned.mismatched.join(", "),
      );
      diff = null;
    }
  }
  if (diff !== null) {
    report("chat base-diff gate resolved base ref", diff.ok, diff.reason ?? "");
    report("chat transport untouched vs merge-base", diff.ok && diff.changed.length === 0, diff.changed.join(", "));
  }
}

// —— 삼순 5차 NO-GO: fallback 제어흐름을 assertUntouchedFiles 최종 판정까지 관통해 검증 ——
// report 심으로 최종 verdict를 포집한다 — primitive 단위가 아니라 게이트 함수 자체를 실행.
function runUntouchedFilesFlow({ evalBase, fetchBase, evalPins }) {
  const verdicts = [];
  assertUntouchedFiles({
    evalBase,
    fetchBase,
    evalPins,
    report: (name, condition) => verdicts.push({ name, red: !condition }),
  });
  return verdicts;
}

function assertFallbackControlFlow() {
  // ① origin/main 없음 → fetch 성공 → dirty diff → 최종 RED
  let evalCalls = 0;
  const dirtyFlow = runUntouchedFilesFlow({
    evalBase: (paths, opts) => {
      evalCalls += 1;
      if (!opts?.baseRef) return { ok: false, reason: "origin/main missing", changed: [] };
      return { ok: true, changed: ["src/lib/supabase/useChat.ts"] };
    },
    fetchBase: () => "fetched-base-sha",
    evalPins: () => { throw new Error("pins must not run when fetch succeeds"); },
  });
  ok("flow ①: origin 없음→fetch 성공 시 FETCH_HEAD 기준으로 재평가",
    evalCalls === 2);
  ok("flow ①: fetch 성공 + dirty chat diff → 최종 RED",
    dirtyFlow.some((v) => v.name === "chat transport untouched vs merge-base" && v.red === true));
  ok("flow ①: fetch 성공 경로에선 pinned fallback 미실행",
    !dirtyFlow.some((v) => v.name.includes("pinned-hash fallback")));

  // ② fetch 실패 → 13핀 전부 clean → 최종 GREEN (pinned fallback 단독 판정)
  const pinFlow = runUntouchedFilesFlow({
    evalBase: () => ({ ok: false, reason: "origin/main missing", changed: [] }),
    fetchBase: () => null,
    evalPins: () => evaluatePinnedChatHashes(),
  });
  const pinVerdict = pinFlow.find((v) => v.name.includes("pinned-hash fallback"));
  ok("flow ②: fetch 실패 → pinned fallback 실행됨", pinVerdict !== undefined);
  ok("flow ②: 13핀 clean → 최종 GREEN", pinVerdict !== undefined && pinVerdict.red === false);
  ok("flow ②: fallback 경로에선 base-diff 판정 미출력(이중 판정 방지)",
    !pinFlow.some((v) => v.name === "chat transport untouched vs merge-base"));

  // ②-RED 대조: fetch 실패 + 핀 mismatch → 최종 RED (GREEN이 조건 무관 고정이 아님을 증명)
  const pinRedFlow = runUntouchedFilesFlow({
    evalBase: () => ({ ok: false, reason: "origin/main missing", changed: [] }),
    fetchBase: () => null,
    evalPins: () => ({ ok: false, mismatched: ["src/lib/supabase/useChat.ts"] }),
  });
  const pinRedVerdict = pinRedFlow.find((v) => v.name.includes("pinned-hash fallback"));
  ok("flow ②-대조: fetch 실패 + pin mismatch → 최종 RED",
    pinRedVerdict !== undefined && pinRedVerdict.red === true);
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
        "          if (mySeq <= channelRef.current) return;\n",
        "          if (mySeq !== requestSeqRef.current) return;\n",
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
  assertFallbackControlFlow();
  assertUntouchedFiles();

  if (SELFTEST) runSelfTest();

  console.log(`live-multiplex-gate: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
