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
let skip = 0;

// Vercel 판정 SSOT — --ci 명시 모드에서는 ambient VERCEL env와 무관하게 항상 false
// (삼순 5차: 동일 명령이면 CI 러너에 VERCEL=1이 있을 때 CI까지 SKIP되는 구멍).
// CI(qa:live-multiplex:ci)는 base 확보가 가능해야 하는 환경이므로 무조건 fail-close.
export function resolveIsVercel({ argv = process.argv, env = process.env } = {}) {
  if (argv.includes("--ci")) return false;
  return env.VERCEL === "1" || env.VERCEL === "true";
}

// 명시 SKIP — pass로 세지 않고 별도 카운터 + 항상 출력(삼순 5차: report(...,true)는
// 로그 없이 pass만 증가해 '명시 SKIP' 계약과 불일치했다).
function markSkip(name, detail = "") {
  skip += 1;
  console.log(`  ○ SKIP ${name}${detail ? ` (${detail})` : ""}`);
}

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
// (핀은 shallow-clone fallback 전용이다 — git diff 가능한 경로에서는 핀이 판정에
// 일절 관여하지 않는다. 같은 PR 코드+핀 동시 변경은 '승인'이 아니라 자기서명이므로
// 핀 갱신으로 merge-base 축 RED를 우회할 수 없다 — 삼순 2026-08-23 #1291.)
//
// merge-base 축 scope 계약 (2026-08-23 #1291 교정):
//  · multiplex 민감 경로(MULTIPLEX_SENSITIVE_PATHS)가 변경된 PR에서만
//    chat transport 무변경을 강제한다(동시 변경 = RED, 핀 상태 무관).
//  · chat-only UI PR은 이 축에서 GREEN — 행위 검증은 전용 게이트
//    (qa:kgwan-autofocus + game-chat-visibility 스모크/게이트)가 담당한다.
//  · multiplex-only PR도 GREEN(채팅 무변경이므로).
// 계약: 핀 집합은 CHAT_BASE_DIFF_PATHS 와 정확히 같아야 한다(set equality — 부분 핀은 fail-open이라 금지,
// 게이트 시작 시점에 항상 검사하므로 핀 누락/윴여는 fallback 경로와 무관하게 즉시 RED).
const CHAT_TRANSPORT_SHA256 = {
  "src/lib/supabase/useChat.ts": "1a3253dfb9bb01c94ddd820673661c2f6ac226c97e9887932904c0a24b388548",
  "src/components/game/GameChat.tsx": "9270d8051c67891e848ce290a147a25950d03d2cfbb1265e57123bc3a2268495",
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

// multiplex 민감 경로 — 이 파일들이 merge-base 대비 변경된 PR에서만 chat transport
// 무변경을 강제한다(scope 게이트). #1274 멀티플렉스 런타임 종단 경로 전체.
const MULTIPLEX_SENSITIVE_PATHS = [
  "src/lib/game/live-poll-stream.ts",
  "src/lib/hooks/useGameRelay.ts",
  "src/app/api/game-relay-events/route.ts",
  "src/lib/hooks/useLiveGame.ts",
  "src/lib/hooks/useGameDetail.ts",
  "src/app/(main)/games/[gameId]/page.tsx",
];

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
  // 삼순 4차(2026-08-25) ②: applyFrame 이 채널별 generation fence(genSnapshot, genRef)를 받는다.
  // live 는 liveGenerationRef, detail 은 detailGenerationRef 로 분리 — 공용 relayGenerationRef ❌.
  ok("relay hook forwards live\/detail frames through per-channel generation refs",
    /applyFrame\(liveFrameOwnerSeqRef, options\?\.onLiveFrame, envelope, myLiveGeneration, liveGenerationRef\);[\s\S]*applyFrame\(detailFrameOwnerSeqRef, options\?\.onDetailFrame, envelope, myDetailGeneration, detailGenerationRef\);/.test(src));
  // fencing 은 shouldApplyRelayResponse 에 유지된다. B안(2026-08-25)에서 그 앞에
  // P0-3 generation fence(shouldApplyPollResponse)를 AND 로 강화했으므로 `if (` 시작을
  // 요구하지 않고 fencing 술어 자체의 존재를 확인한다(fencing 제거는 여전히 검출).
  ok("relay frame fencing remains on shouldApplyRelayResponse",
    /shouldApplyRelayResponse\(\{[\s\S]*requestSeq: mySeq,[\s\S]*currentSeq: requestSeqRef\.current/.test(src));
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
  isVercel = resolveIsVercel(),
  reportSkip = markSkip,
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
  let baseOpts;
  let chatDiff = evalBase(CHAT_BASE_DIFF_PATHS);
  if (!chatDiff.ok && chatDiff.reason === "origin/main missing") {
    const fetchedBase = fetchBase();
    if (fetchedBase) {
      baseOpts = { baseRef: fetchedBase };
      chatDiff = evalBase(CHAT_BASE_DIFF_PATHS, baseOpts);
    } else {
      // base 미확보(fetch도 불가) — 신뢰할 base 없는 scope 판정은 불가능하다.
      // 핀은 repo에 커밋되므로 같은 PR 코드+핀 동시 갱신(자기서명)을 핀 대조로는
      // 검출할 수 없다(삼순 2026-08-23 3차) — 핀은 진단 정보로만 출력.
      // · Vercel 빌드: 자격 없는 shallow clone이라 base 확보가 원리적 불가
      //   (2026-08-23 dpl_6oqxj2Lx 실측: fail-close가 배포를 죽임 — 1afb4643a 재발).
      //   이 축은 base가 있는 CI(qa:live-multiplex:ci)가 강제하므로 여기서는
      //   판정 없이 '스킵'을 명시 보고한다(GREEN 판정이 아니라 축 미실행 공지).
      // · 그 외 환경(CI 등 base를 확보할 수 있어야 하는 곳): fail-close RED.
      const pinned = evalPins();
      if (isVercel) {
        console.log(`  ℹ pins diagnostic: ${pinned.ok ? "clean" : pinned.mismatched.join(", ")}`);
        reportSkip(
          "chat scope axis on Vercel (base unavailable — 실판정은 CI qa:live-multiplex:ci가 --ci로 강제)",
        );
      } else {
        report(
          "chat transport untouched (base unavailable — fail-close)",
          false,
          `origin/main 미확보 + fetch 불가 — scope 판정 불가, 사람 확인 필요 (pins: ${pinned.ok ? "clean" : pinned.mismatched.join(", ")})`,
        );
      }
      return;
    }
  }
  const muxDiff = evalBase(MULTIPLEX_SENSITIVE_PATHS, baseOpts);
  report("chat base-diff gate resolved base ref", chatDiff.ok && muxDiff.ok, chatDiff.reason ?? muxDiff.reason ?? "");
  // scope 판정: multiplex 민감 경로와 chat transport가 *동시에* 변경된 PR만 RED.
  // 핀 상태는 이 판정에 관여하지 않는다(핀 동시변경 자기서명 우회 불가 — 삼순 계약).
  const muxChanged = muxDiff.changed;
  const chatChanged = chatDiff.changed;
  if (muxChanged.length === 0 && chatChanged.length > 0) {
    console.log(`  ℹ chat-only 변경(전용 행위 게이트가 검증): ${chatChanged.join(", ")}`);
  }
  report(
    "chat transport untouched vs merge-base",
    chatDiff.ok && muxDiff.ok && !(muxChanged.length > 0 && chatChanged.length > 0),
    muxChanged.length > 0 && chatChanged.length > 0
      ? `multiplex+chat 동시 변경 — mux: ${muxChanged.join(", ")} / chat: ${chatChanged.join(", ")}`
      : "",
  );
}

// —— 삼순 5차 NO-GO: fallback 제어흐름을 assertUntouchedFiles 최종 판정까지 관통해 검증 ——
// report 심으로 최종 verdict를 포집한다 — primitive 단위가 아니라 게이트 함수 자체를 실행.
function runUntouchedFilesFlow({ evalBase, fetchBase, evalPins, isVercel = false }) {
  const verdicts = [];
  assertUntouchedFiles({
    evalBase,
    fetchBase,
    evalPins,
    isVercel,
    reportSkip: (name) => verdicts.push({ name: `SKIP ${name}`, red: false, skipped: true }),
    report: (name, condition) => verdicts.push({ name, red: !condition }),
  });
  return verdicts;
}

// scope 스텁: paths 인자가 chat 집합인지 mux 집합인지로 구분해 응답한다.
function makeScopeEvalBase({ chatChanged = [], muxChanged = [], requireFetch = false }) {
  const calls = { chat: 0, mux: 0 };
  const fn = (paths, opts) => {
    const isMux = paths === MULTIPLEX_SENSITIVE_PATHS || paths.includes("src/lib/hooks/useGameRelay.ts");
    if (isMux) calls.mux += 1;
    else calls.chat += 1;
    if (requireFetch && !opts?.baseRef) return { ok: false, reason: "origin/main missing", changed: [] };
    return { ok: true, changed: isMux ? muxChanged : chatChanged };
  };
  return { fn, calls };
}

function assertFallbackControlFlow() {
  // ① origin/main 없음 → fetch 성공 → FETCH_HEAD 기준 재평가(chat 재호출 + mux 호출)
  const fetched = makeScopeEvalBase({ chatChanged: [], muxChanged: [], requireFetch: true });
  const fetchedFlow = runUntouchedFilesFlow({
    evalBase: fetched.fn,
    fetchBase: () => "fetched-base-sha",
    evalPins: () => { throw new Error("pins must not run when fetch succeeds"); },
  });
  ok("flow ①: origin 없음→fetch 성공 시 FETCH_HEAD 기준으로 chat 재평가 + mux 평가",
    fetched.calls.chat === 2 && fetched.calls.mux === 1);
  ok("flow ①: 무변경 → 최종 GREEN + pinned fallback 미실행",
    fetchedFlow.some((v) => v.name === "chat transport untouched vs merge-base" && v.red === false)
    && !fetchedFlow.some((v) => v.name.includes("pinned-hash fallback")));

  // ② fetch 실패(base 미확보) → fail-close RED — 핀 clean이어도 GREEN 금지
  //    (삼순 3차: 핀은 같은 PR 동시갱신으로 자기서명 가능 → base 없으면 판정 불가 = RED)
  const pinFlow = runUntouchedFilesFlow({
    evalBase: () => ({ ok: false, reason: "origin/main missing", changed: [] }),
    fetchBase: () => null,
    evalPins: () => ({ ok: true, mismatched: [] }),
  });
  const pinVerdict = pinFlow.find((v) => v.name.includes("base unavailable"));
  ok("flow ②: fetch 실패 → fail-close 경로 실행됨", pinVerdict !== undefined);
  ok("flow ②: base 미확보면 핀 clean이어도 최종 RED(fail-close)",
    pinVerdict !== undefined && pinVerdict.red === true);
  ok("flow ②: fallback 경로에선 base-diff 판정 미출력(이중 판정 방지)",
    !pinFlow.some((v) => v.name === "chat transport untouched vs merge-base"));

  // ②-대조: fetch 실패 + mux+chat+핀 동시갱신(자기서명 시도) → 여전히 RED — ③-d가 fallback에서도 관통
  const pinBypassFallback = runUntouchedFilesFlow({
    evalBase: () => ({ ok: false, reason: "origin/main missing", changed: [] }),
    fetchBase: () => null,
    evalPins: () => ({ ok: true, mismatched: [] }),
  });
  const bypassVerdict = pinBypassFallback.find((v) => v.name.includes("base unavailable"));
  ok("flow ②-대조: base 미확보 + 핀 동시갱신 전부일치 → 그래도 RED (fallback 자기서명 우회 불가)",
    bypassVerdict !== undefined && bypassVerdict.red === true);

  // ②-Vercel: base 미확보 + Vercel 빌드 → 명시 SKIP(배포 비차단)이며 판정 미출력 —
  //    GREEN 판정("untouched")도 fail-close RED도 아닌 축 미실행 공지임을 증명
  //    (2026-08-23 dpl_6oqxj2Lx 실측: Vercel은 base 확보 원리적 불가 → fail-close가 배포를 죽였다).
  const vercelFlow = runUntouchedFilesFlow({
    evalBase: () => ({ ok: false, reason: "origin/main missing", changed: [] }),
    fetchBase: () => null,
    evalPins: () => ({ ok: true, mismatched: [] }),
    isVercel: true,
  });
  const vercelSkip = vercelFlow.find((v) => v.skipped === true && v.name.includes("chat scope axis on Vercel"));
  ok("flow ②-Vercel: base 미확보 + Vercel → 명시 SKIP 보고(배포 비차단, skipped 플래그)",
    vercelSkip !== undefined && vercelSkip.red === false);
  ok("flow ②-Vercel: SKIP 경로에서 판정 미출력(untouched GREEN도 fail-close RED도 아님)",
    !vercelFlow.some((v) => v.name === "chat transport untouched vs merge-base")
    && !vercelFlow.some((v) => v.name.includes("base unavailable — fail-close")));

  // ②-CI: --ci 명시 모드는 ambient VERCEL env와 무관하게 isVercel=false → base 미확보 시 fail-close
  //    (삼순 5차: 동일 명령이면 CI 러너의 VERCEL=1이 CI까지 SKIP시키는 구멍)
  ok("flow ②-CI: resolveIsVercel — --ci면 VERCEL=1이어도 false(무조건 실판정)",
    resolveIsVercel({ argv: ["node", "gate", "--ci"], env: { VERCEL: "1" } }) === false
    && resolveIsVercel({ argv: ["node", "gate"], env: { VERCEL: "1" } }) === true
    && resolveIsVercel({ argv: ["node", "gate"], env: {} }) === false);
  const ciFlow = runUntouchedFilesFlow({
    evalBase: () => ({ ok: false, reason: "origin/main missing", changed: [] }),
    fetchBase: () => null,
    evalPins: () => ({ ok: true, mismatched: [] }),
    isVercel: resolveIsVercel({ argv: ["node", "gate", "--ci"], env: { VERCEL: "1" } }),
  });
  ok("flow ②-CI: --ci + VERCEL=1 + base 미확보 → SKIP 없이 fail-close RED",
    ciFlow.some((v) => v.name.includes("base unavailable — fail-close") && v.red === true)
    && !ciFlow.some((v) => v.skipped === true));
  // seam 동일성: 기본값 배선이 resolveIsVercel을 쓴다(주석 blank 후 구조 확인).
  ok("flow ②-CI: assertUntouchedFiles 기본값이 resolveIsVercel에 결속",
    /isVercel = resolveIsVercel\(\)/.test(stripComments(read("scripts/qa/live-multiplex-gate.mjs"))));

  // ③ scope 4축 (삼순 2026-08-23 계약: chat-only GREEN / mux-only GREEN /
  //    mux+chat RED / 핀 동시변경으로 RED 우회 불가)
  const verdictOf = (flow) => flow.find((v) => v.name === "chat transport untouched vs merge-base");

  // ③-a chat-only 변경 → GREEN (행위 검증은 전용 게이트 담당)
  const chatOnly = runUntouchedFilesFlow({
    evalBase: makeScopeEvalBase({ chatChanged: ["src/components/game/GameChat.tsx"] }).fn,
    fetchBase: () => { throw new Error("fetch must not run when origin/main resolves"); },
    evalPins: () => ({ ok: false, mismatched: ["src/components/game/GameChat.tsx"] }),
  });
  ok("flow ③-a: chat-only 변경 → 최종 GREEN (핀 stale여도 무관)",
    verdictOf(chatOnly)?.red === false);

  // ③-b multiplex-only 변경 → GREEN
  const muxOnly = runUntouchedFilesFlow({
    evalBase: makeScopeEvalBase({ muxChanged: ["src/lib/hooks/useGameRelay.ts"] }).fn,
    fetchBase: () => { throw new Error("fetch must not run when origin/main resolves"); },
    evalPins: () => ({ ok: true, mismatched: [] }),
  });
  ok("flow ③-b: multiplex-only 변경 → 최종 GREEN",
    verdictOf(muxOnly)?.red === false);

  // ③-c multiplex+chat 동시 변경 → RED
  const both = runUntouchedFilesFlow({
    evalBase: makeScopeEvalBase({
      chatChanged: ["src/components/game/GameChat.tsx"],
      muxChanged: ["src/lib/hooks/useGameRelay.ts"],
    }).fn,
    fetchBase: () => { throw new Error("fetch must not run when origin/main resolves"); },
    evalPins: () => ({ ok: false, mismatched: ["src/components/game/GameChat.tsx"] }),
  });
  ok("flow ③-c: multiplex+chat 동시 변경 → 최종 RED",
    verdictOf(both)?.red === true);

  // ③-d 핀 동시변경(자기서명)으로 RED 우회 불가 — 핀이 전부 일치(ok)라도 RED 유지
  const pinBypass = runUntouchedFilesFlow({
    evalBase: makeScopeEvalBase({
      chatChanged: ["src/components/game/GameChat.tsx"],
      muxChanged: ["src/lib/hooks/useGameRelay.ts"],
    }).fn,
    fetchBase: () => { throw new Error("fetch must not run when origin/main resolves"); },
    evalPins: () => ({ ok: true, mismatched: [] }),
  });
  ok("flow ③-d: mux+chat 변경 + 핀 동시갱신(전부 일치) → 그래도 RED (자기서명 우회 불가)",
    verdictOf(pinBypass)?.red === true);
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

  console.log(`live-multiplex-gate: ${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
