#!/usr/bin/env node
/**
 * summary-final-transition-gate (npm run qa:summary-final-transition / :selftest)
 *
 * 계약 (2026-08-29 #cs "경기요약 안됨" — LG:롯데 7회 강우콜드 인시던트, 삼순 NO-GO 반영):
 * KBO 가 콜드게임 final 전이를 실플레이 중단 후 ~1h40m 늦게 내려줬고(20:43→22:21),
 * prewarm 크론(매시 :15)의 최대 60분 공백 때문에 유저가 종료 화면에서 요약 없음을 봤다.
 *
 *  F1~F5  canonicalGate replay — final 지연 fail-close / 7이닝 콜드 ok(이닝수 하드코딩 금지) /
 *         소스 불일치·부재 not-settled / canonical race 저장 거부.
 *  S1~S6  백필 선정(selectSummaryBackfillGames) — final+row없음만 / live·존재·상태미상·올스타
 *         제외 / per-tick 상한.
 *  R1~R6  유계 재시도(backfillRetryDecision) — 1~3회 매틱 즉시, 4~6회 4분, 7~10회 14분 backoff,
 *         상한(10회) 소진 시 exhausted. "row 없으면 매분 영구 재시도" 회귀 차단(삼순 ②).
 *  O1~O5  관측 분류(classifyGenerationFailure/canonicalFailureStage) — 정상 동시요청
 *         (claim-contention/save-superseded)은 별도 api_name+비경보 임계치, 실패축은 경보(3/30분),
 *         backfill-exhausted 는 즉시 경보(1회), 초기 canonical 실패는 기록·not-final 은 제외(삼순 ①).
 *  B1~B7  러너 행동(runSummaryBackfill, mock deps — production seam 직접 실행):
 *         조회 실패 fail-close / 시도 기록이 POST 보다 선행 / give-up 1회·중복 없음 /
 *         backoff 시 미발사 / recordAttempt 실패 시 미발사.
 *  W축    배선 — warmup 이 러너를 즉시 시작(promise 생성 후 after(promise))하고, route 가
 *         canonicalFailureStage·classifyGenerationFailure 를 실제로 사용한다.
 *
 * 순수 판정(F/S/R/O/B)은 production seam 과 *같은 함수*를 import 해 직접 실행한다.
 * --selftest: 실제 소스 변이(mutation) 8종으로 각 축이 RED 를 낼 수 있음을 증명.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalGate, createSummaryFingerprint, shouldSaveGeneratedSummary } from "../../src/lib/game-summary/cache-validation";
import {
  selectSummaryBackfillGames,
  backfillRetryDecision,
  KBO_GAME_STATE_FINAL,
  SUMMARY_BACKFILL_MAX_PER_TICK,
  SUMMARY_BACKFILL_MAX_ATTEMPTS,
} from "../../src/lib/game-summary/final-transition";
import {
  classifyGenerationFailure,
  canonicalFailureStage,
  GENERATION_ALERT_API,
  GENERATION_CONTENTION_API,
} from "../../src/lib/game-summary/failure-observability";
import { runSummaryBackfill } from "../../src/lib/game-summary/backfill-runner";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SELFTEST = process.argv.includes("--selftest");

const failures = [];
function check(id, ok, detail) {
  if (ok) console.log(`  PASS  ${id}`);
  else {
    console.log(`  FAIL  ${id}${detail ? ` — ${detail}` : ""}`);
    failures.push(id);
  }
}

/** 주석·문서 문면이 assertion 을 만족시키지 못하게 blank 처리(오프셋 보존). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

// ===== 픽스처: 2026-08-29 LGLT0 7회 강우콜드 실데이터 =====
const LGLT_AWAY_INNINGS = [0, 3, 0, 0, 5, 0, 0];
const LGLT_HOME_INNINGS = [0, 1, 1, 0, 0, 1, 0];
const lgltLinescoreFinal = {
  status: "final",
  away: { R: 8, innings: [...LGLT_AWAY_INNINGS] },
  home: { R: 3, innings: [...LGLT_HOME_INNINGS] },
};

// ===== F/S축 =====
function runContractChecks({ select }) {
  const live = canonicalGate({ status: "live", awayScore: 8, homeScore: 3 }, lgltLinescoreFinal);
  check("F1-final-delay-fail-close", live.reason === "not-final" && live.httpStatus === 409 && !live.fingerprint,
    `got ${live.reason}`);

  const ok = canonicalGate({ status: "final", awayScore: 8, homeScore: 3 }, lgltLinescoreFinal);
  check("F2-cold-game-7innings-ok",
    ok.reason === "ok" && ok.fingerprint?.awayInnings.length === 7 && ok.fingerprint?.homeInnings.length === 7,
    `got ${ok.reason} innings=${ok.fingerprint?.awayInnings.length}`);

  const mismatch = canonicalGate({ status: "final", awayScore: 7, homeScore: 3 }, lgltLinescoreFinal);
  check("F3-source-mismatch-not-settled", mismatch.reason === "canonical-not-settled", `got ${mismatch.reason}`);

  const noLinescore = canonicalGate({ status: "final", awayScore: 8, homeScore: 3 }, null);
  check("F4-linescore-absent-not-settled", noLinescore.reason === "canonical-not-settled", `got ${noLinescore.reason}`);

  const genFp = createSummaryFingerprint(8, 3, LGLT_AWAY_INNINGS, LGLT_HOME_INNINGS);
  const changedFp = createSummaryFingerprint(8, 3, [0, 3, 0, 0, 5, 0, 0, 0], LGLT_HOME_INNINGS);
  check("F5-canonical-race-save-refused",
    shouldSaveGeneratedSummary(genFp, genFp) === true && shouldSaveGeneratedSummary(genFp, changedFp) === false);

  const existing = new Set(["20260829KTSS0"]);
  const candidates = [
    { gameId: "20260829LGLT0", gameStateSc: KBO_GAME_STATE_FINAL },
    { gameId: "20260829NCHH0", gameStateSc: "2" },
    { gameId: "20260829KTSS0", gameStateSc: KBO_GAME_STATE_FINAL },
    { gameId: "20260829WOOB0", gameStateSc: null },
    { gameId: "20260717EWWE0", gameStateSc: KBO_GAME_STATE_FINAL },
  ];
  const picked = select(candidates, existing);
  check("S1-final-missing-selected", picked.includes("20260829LGLT0"), `picked=${picked}`);
  check("S2-live-excluded", !picked.includes("20260829NCHH0"), `picked=${picked}`);
  check("S3-existing-excluded", !picked.includes("20260829KTSS0"), `picked=${picked}`);
  check("S4-unknown-state-excluded", !picked.includes("20260829WOOB0"), `picked=${picked}`);
  check("S6-allstar-excluded", !picked.includes("20260717EWWE0"), `picked=${picked}`);

  const many = ["LGLT", "SSHT", "OBWO", "NCHH", "KTSS"].map((c) => ({
    gameId: `20260829${c}0`,
    gameStateSc: KBO_GAME_STATE_FINAL,
  }));
  const capped = select(many, new Set());
  check("S5-per-tick-cap", capped.length === SUMMARY_BACKFILL_MAX_PER_TICK,
    `len=${capped.length} cap=${SUMMARY_BACKFILL_MAX_PER_TICK}`);
}

// ===== R축: 유계 재시도 =====
function runRetryChecks({ decide }) {
  const T = 1_000_000_000_000;
  check("R1-first-attempt-immediate", decide(0, null, T) === "attempt");
  check("R2-early-attempts-every-tick", decide(3, T - 60_000, T) === "attempt", `got ${decide(3, T - 60_000, T)}`);
  check("R3-mid-backoff-held", decide(4, T - 60_000, T) === "backoff", `got ${decide(4, T - 60_000, T)}`);
  check("R4-mid-backoff-elapsed", decide(4, T - 5 * 60_000, T) === "attempt");
  check("R5-late-backoff-14min", decide(7, T - 5 * 60_000, T) === "backoff" && decide(7, T - 15 * 60_000, T) === "attempt");
  check("R6-max-attempts-exhausted",
    decide(SUMMARY_BACKFILL_MAX_ATTEMPTS, T - 60 * 60_000, T) === "exhausted" &&
    decide(SUMMARY_BACKFILL_MAX_ATTEMPTS + 5, null, T) === "exhausted",
    `got ${decide(SUMMARY_BACKFILL_MAX_ATTEMPTS, T - 60 * 60_000, T)}`);
}

// ===== O축: 관측 분류 =====
function runObservabilityChecks({ classify }) {
  const benign = ["claim-contention", "save-superseded"].map(classify);
  check("O1-benign-contention-non-alerting",
    benign.every((c) => c.apiName === GENERATION_CONTENTION_API && c.apiName !== GENERATION_ALERT_API && c.policy.threshold >= 100),
    JSON.stringify(benign.map((c) => [c.apiName, c.policy.threshold])));

  const failureStages = ["canonical-not-settled", "canonical-boxscore-unavailable", "canonical-unavailable",
    "gemini-empty", "gemini-parse", "score-mismatch", "winner-mismatch", "consistency-violation",
    "canonical-race", "save-failed", "generation-exception"].map(classify);
  check("O2-failure-stages-alerting",
    failureStages.every((c) => c.apiName === GENERATION_ALERT_API && c.policy.threshold === 3),
    JSON.stringify(failureStages.map((c) => [c.apiName, c.policy.threshold])));

  check("O3-gemini-http-reason", classify("gemini-api").reason === "http-error" && classify("gemini-api").apiName === GENERATION_ALERT_API);

  const giveUp = classify("backfill-exhausted");
  check("O4-giveup-immediate-alert", giveUp.apiName === GENERATION_ALERT_API && giveUp.policy.threshold === 1,
    JSON.stringify([giveUp.apiName, giveUp.policy.threshold]));

  check("O5-canonical-stage-mapping",
    canonicalFailureStage("canonical-not-settled") === "canonical-not-settled" &&
    canonicalFailureStage("canonical-boxscore-unavailable") === "canonical-boxscore-unavailable" &&
    canonicalFailureStage("canonical-unavailable") === "canonical-unavailable" &&
    canonicalFailureStage("not-final") === null &&
    canonicalFailureStage("invalid-gameid") === null);
}

// ===== B축: 러너 행동 (mock deps) =====
function makeDeps(overrides = {}) {
  const calls = { record: [], posts: [], gaveUp: [], reports: [], order: [] };
  const deps = {
    listExistingSummaries: async () => ({ ok: true, existing: new Set() }),
    readAttemptStates: async () => ({ ok: true, states: new Map() }),
    recordAttempt: async (gameId, n) => {
      calls.record.push([gameId, n]);
      calls.order.push(`record:${gameId}`);
      return { ok: true };
    },
    markGaveUp: async (gameId) => calls.gaveUp.push(gameId),
    postSummary: async (gameId) => {
      calls.posts.push(gameId);
      calls.order.push(`post:${gameId}`);
      return { status: 200, result: "generated" };
    },
    reportGiveUp: (gameId, attempts) => calls.reports.push([gameId, attempts]),
    nowMs: () => 1_000_000_000_000,
    ...overrides,
  };
  return { deps, calls };
}
const FINAL_CAND = [{ gameId: "20260829LGLT0", gameStateSc: "3" }];

async function runBehaviorChecks({ run }) {
  {
    const { deps, calls } = makeDeps({ listExistingSummaries: async () => ({ ok: false, existing: new Set() }) });
    const r = await run(FINAL_CAND, deps);
    check("B1-existence-fail-close", r.failClosed === true && calls.posts.length === 0 && calls.record.length === 0);
  }
  {
    const { deps, calls } = makeDeps();
    const r = await run(FINAL_CAND, deps);
    check("B2-fresh-final-launched", r.launched.length === 1 && calls.record.length === 1 && calls.record[0][1] === 1);
    check("B7-attempt-recorded-before-post",
      calls.order.join(",") === "record:20260829LGLT0,post:20260829LGLT0", calls.order.join(","));
  }
  {
    const states = new Map([["20260829LGLT0", { attempts: SUMMARY_BACKFILL_MAX_ATTEMPTS, lastAttemptAtMs: 1, gaveUp: false }]]);
    const { deps, calls } = makeDeps({ readAttemptStates: async () => ({ ok: true, states }) });
    const r = await run(FINAL_CAND, deps);
    check("B3-exhausted-giveup-once",
      calls.posts.length === 0 && calls.gaveUp.length === 1 && calls.reports.length === 1 && r.gaveUp.length === 1,
      JSON.stringify(calls));
    const states2 = new Map([["20260829LGLT0", { attempts: SUMMARY_BACKFILL_MAX_ATTEMPTS, lastAttemptAtMs: 1, gaveUp: true }]]);
    const { deps: d2, calls: c2 } = makeDeps({ readAttemptStates: async () => ({ ok: true, states: states2 }) });
    await run(FINAL_CAND, d2);
    check("B3b-no-duplicate-giveup", c2.gaveUp.length === 0 && c2.reports.length === 0 && c2.posts.length === 0, JSON.stringify(c2));
  }
  {
    const states = new Map([["20260829LGLT0", { attempts: 4, lastAttemptAtMs: 1_000_000_000_000 - 60_000, gaveUp: false }]]);
    const { deps, calls } = makeDeps({ readAttemptStates: async () => ({ ok: true, states }) });
    const r = await run(FINAL_CAND, deps);
    check("B4-backoff-no-post", r.backedOff.length === 1 && calls.posts.length === 0 && calls.record.length === 0);
  }
  {
    const { deps, calls } = makeDeps({ readAttemptStates: async () => ({ ok: false, states: new Map() }) });
    const r = await run(FINAL_CAND, deps);
    check("B5-state-fail-close", r.failClosed === true && calls.posts.length === 0);
  }
  {
    const { deps, calls } = makeDeps({ recordAttempt: async () => ({ ok: false }) });
    const r = await run(FINAL_CAND, deps);
    check("B6-record-fail-no-post", calls.posts.length === 0 && r.failClosed === true);
  }
}

// ===== W축: 배선(소스 구조 검사, 주석 blank) =====
function runWiringChecks() {
  const warmup = stripComments(readFileSync(path.join(ROOT, "src/app/api/cron/game-events-warmup/route.ts"), "utf8"));
  check("W1a-warmup-runs-runner", /const summaryBackfillPromise = runSummaryBackfill\(/.test(warmup));
  check("W1b-warmup-immediate-not-deferred", /after\(summaryBackfillPromise\)/.test(warmup) && !/after\(async \(\) =>[\s\S]{0,400}runSummaryBackfill/.test(warmup),
    "러너는 즉시 시작하고 after 에는 promise 만 넘겨야 한다");
  check("W1c-warmup-durable-state-wired", /from\(\s*"game_summary_backfill_state"\s*\)/.test(warmup));
  check("W1d-warmup-giveup-alert", /classifyGenerationFailure\(\s*"backfill-exhausted"\s*\)/.test(warmup));

  const route = stripComments(readFileSync(path.join(ROOT, "src/app/api/game-summary/route.ts"), "utf8"));
  const reportCalls = (route.match(/reportGenerationFailure\(/g) || []).length;
  check("W2a-failure-exits-wired", reportCalls >= 12, `reportGenerationFailure calls=${reportCalls} (need ≥12)`);
  check("W2b-canonical-failure-recorded", /canonicalFailureStage\(/.test(route));
  check("W2c-classification-seam", /classifyGenerationFailure\(stage\)/.test(route));
}

// ===== selftest: 실제 소스 변이로 검증력 증명 =====
async function importMutated(relPath, needle, replacement, aliasRewrites) {
  const src = readFileSync(path.join(ROOT, relPath), "utf8");
  if (!src.includes(needle)) return { error: "mutation target not found" };
  let mutated = src.replace(needle, replacement);
  for (const [from, to] of aliasRewrites) mutated = mutated.split(from).join(to);
  const dir = mkdtempSync(path.join(tmpdir(), "summary-gate-mut-"));
  const file = path.join(dir, path.basename(relPath));
  writeFileSync(file, mutated);
  try {
    const mod = await import(file);
    return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { error: `import failed: ${e.message}` };
  }
}

async function runSelftest() {
  const teamsAbs = path.join(ROOT, "src/lib/constants/teams").replace(/\\/g, "/");
  const ftAbs = path.join(ROOT, "src/lib/game-summary/final-transition").replace(/\\/g, "/");
  const FT = "src/lib/game-summary/final-transition.ts";
  const FO = "src/lib/game-summary/failure-observability.ts";
  const BR = "src/lib/game-summary/backfill-runner.ts";
  const teamsRw = [["@/lib/constants/teams", teamsAbs]];
  const ftRw = [["@/lib/game-summary/final-transition", ftAbs]];

  const mutations = [
    ["M1-drop-existing-check", FT, "if (existingSummaryIds.has(c.gameId)) continue;", "", teamsRw,
      (mod) => runContractChecks({ select: mod.selectSummaryBackfillGames }), ["S3-existing-excluded"]],
    ["M2-drop-state-check", FT, "if (c.gameStateSc !== KBO_GAME_STATE_FINAL) continue;", "", teamsRw,
      (mod) => runContractChecks({ select: mod.selectSummaryBackfillGames }), ["S2-live-excluded"]],
    ["M3-drop-allstar-check", FT, "if (isAllStarGameId(c.gameId)) continue;", "", teamsRw,
      (mod) => runContractChecks({ select: mod.selectSummaryBackfillGames }), ["S6-allstar-excluded"]],
    ["M4-drop-cap", FT, "if (out.length >= maxPerTick) break;", "", teamsRw,
      (mod) => runContractChecks({ select: mod.selectSummaryBackfillGames }), ["S5-per-tick-cap"]],
    ["M5-drop-max-attempts", FT, 'if (attempts >= maxAttempts) return "exhausted";', "", teamsRw,
      (mod) => runRetryChecks({ decide: mod.backfillRetryDecision }), ["R6-max-attempts-exhausted"]],
    ["M6-zero-backoff", FT, "if (attempts <= 6) return 4 * 60_000;", "if (attempts <= 6) return 0;", teamsRw,
      (mod) => runRetryChecks({ decide: mod.backfillRetryDecision }), ["R3-mid-backoff-held"]],
    ["M7-benign-routed-to-alert", FO, "apiName: GENERATION_CONTENTION_API,", "apiName: GENERATION_ALERT_API,", [],
      (mod) => runObservabilityChecks({ classify: mod.classifyGenerationFailure }), ["O1-benign-contention-non-alerting"]],
    ["M8-drop-giveup-dedupe", BR, "if (state.gaveUp) continue;", "", ftRw,
      (mod) => runBehaviorChecks({ run: mod.runSummaryBackfill }), ["B3b-no-duplicate-giveup"]],
  ];

  let allCaught = true;
  for (const [id, file, needle, replacement, rewrites, exercise, expectFail] of mutations) {
    const m = await importMutated(file, needle, replacement, rewrites);
    if (m.error) {
      console.log(`  FAIL  selftest:${id} — ${m.error} (패치 미적용 = FAIL)`);
      allCaught = false;
      continue;
    }
    const before = failures.length;
    await exercise(m.mod);
    const newFails = failures.splice(before);
    m.cleanup();
    const caught = expectFail.every((f) => newFails.includes(f));
    console.log(`  ${caught ? "PASS" : "FAIL"}  selftest:${id} — mutation ${caught ? "detected(RED)" : "NOT detected"}`);
    if (!caught) allCaught = false;
  }
  return allCaught;
}

console.log("summary-final-transition-gate");
if (SELFTEST) {
  const ok = await runSelftest();
  console.log(ok ? "SELFTEST GREEN — all mutations detected" : "SELFTEST RED — verification power missing");
  process.exit(ok ? 0 : 1);
} else {
  runContractChecks({ select: selectSummaryBackfillGames });
  runRetryChecks({ decide: backfillRetryDecision });
  runObservabilityChecks({ classify: classifyGenerationFailure });
  await runBehaviorChecks({ run: runSummaryBackfill });
  runWiringChecks();
  if (failures.length > 0) {
    console.log(`\nRED — ${failures.length} failure(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nGREEN — all contracts hold");
}
