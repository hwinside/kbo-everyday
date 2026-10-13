#!/usr/bin/env node
/**
 * summary-final-transition-gate (npm run qa:summary-final-transition / :selftest)
 *
 * 계약 (2026-08-29 #cs "경기요약 안됨" — LG:롯데 7회 강우콜드 인시던트, 삼순 재리뷰 반영):
 * KBO 가 콜드게임 final 전이를 실플레이 중단 후 ~1h40m 늦게 내려줬고(20:43→22:21),
 * prewarm 크론(매시 :15)의 최대 60분 공백 때문에 유저가 종료 화면에서 요약 없음을 봤다.
 *
 *  F1~F5  canonicalGate replay — final 지연 fail-close / 7이닝 콜드 ok / 소스 불일치·부재
 *         not-settled / canonical race 저장 거부.
 *  S1~S6  백필 선정 — final+row없음만 / live·존재·상태미상·올스타 제외 / cap 파라미터.
 *  R1~R6  유계 재시도 — 1~3회 즉시, 4~6회 4분, 7~10회 14분 backoff(~70분 소진), 상한 exhausted.
 *  O1~O5  관측 분류 — 정상 동시요청 비경보 분리 / 실패축 경보 / give-up 즉시 경보 /
 *         초기 canonical 실패 기록·not-final 제외.
 *  B1~B12 러너 행동(mock deps — production seam 직접 실행, 삼순 재리뷰 3건):
 *         fail-close / CAS 승자만 발사·기록 선행 / give-up CAS 승자만 report(+mark 에러 시
 *         fail-open report) / awaited report / backoff·gave-up 은 cap 미소비(starvation 부재) /
 *         발사 cap 은 attempt 에만 / 동시 2-run 은 공유 CAS 로 1발사.
 *  W축    배선 — warmup 즉시 시작(promise 후 after(promise)) / CAS 배선 / awaited 경보.
 *
 * --selftest: 실제 소스 변이(mutation) 11종으로 각 축이 RED 를 낼 수 있음을 증명.
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
  check("S5-cap-parameter", select(many, new Set(), 3).length === 3 && select(many, new Set(), 99).length === 5,
    `cap3=${select(many, new Set(), 3).length} cap99=${select(many, new Set(), 99).length}`);
}

// ===== R축: 유계 재시도 (1~3회 즉시 / 4~6회 4분 / 7~10회 14분 ≈ 70분 소진) =====
function runRetryChecks({ decide }) {
  const T = 1_000_000_000_000;
  check("R1-first-attempt-immediate", decide(0, null, T) === "attempt");
  check("R2-first-three-every-tick", decide(2, T - 60_000, T) === "attempt", `got ${decide(2, T - 60_000, T)}`);
  check("R3-fourth-attempt-4min-held", decide(3, T - 60_000, T) === "backoff", `got ${decide(3, T - 60_000, T)}`);
  check("R4-fourth-attempt-4min-elapsed", decide(3, T - 5 * 60_000, T) === "attempt");
  check("R5-seventh-attempt-14min", decide(6, T - 5 * 60_000, T) === "backoff" && decide(6, T - 15 * 60_000, T) === "attempt");
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

// ===== B축: 러너 행동 (mock deps, CAS 계약) =====
const NOW = 1_000_000_000_000;
function makeDeps(overrides = {}) {
  const calls = { claims: [], posts: [], marks: [], reports: [], order: [], reportSettled: false };
  const deps = {
    listExistingSummaries: async () => ({ ok: true, existing: new Set() }),
    readAttemptStates: async () => ({ ok: true, states: new Map() }),
    claimAttempt: async (gameId, expected) => {
      calls.claims.push([gameId, expected]);
      calls.order.push(`claim:${gameId}`);
      return { ok: true, won: true };
    },
    markGaveUp: async (gameId) => {
      calls.marks.push(gameId);
      return { won: true, error: false };
    },
    postSummary: async (gameId) => {
      calls.posts.push(gameId);
      calls.order.push(`post:${gameId}`);
      return { status: 200, result: "generated" };
    },
    reportGiveUp: async (gameId, attempts) => {
      calls.reports.push([gameId, attempts]);
      await new Promise((r) => setTimeout(r, 0));
      calls.reportSettled = true;
    },
    nowMs: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}
const FINAL_CAND = [{ gameId: "20260829LGLT0", gameStateSc: "3" }];
const st = (attempts, lastMs, gaveUp = false) => ({ attempts, lastAttemptAtMs: lastMs, gaveUp });

async function runBehaviorChecks({ run }) {
  {
    const { deps, calls } = makeDeps({ listExistingSummaries: async () => ({ ok: false, existing: new Set() }) });
    const r = await run(FINAL_CAND, deps);
    check("B1-existence-fail-close", r.failClosed === true && calls.posts.length === 0 && calls.claims.length === 0);
  }
  {
    const { deps, calls } = makeDeps();
    const r = await run(FINAL_CAND, deps);
    check("B2-fresh-final-launched", r.launched.length === 1 && calls.claims.length === 1 && calls.claims[0][1] === 0);
    check("B7-claim-before-post", calls.order.join(",") === "claim:20260829LGLT0,post:20260829LGLT0", calls.order.join(","));
  }
  {
    const states = new Map([["20260829LGLT0", st(SUMMARY_BACKFILL_MAX_ATTEMPTS, 1)]]);
    const { deps, calls } = makeDeps({ readAttemptStates: async () => ({ ok: true, states }) });
    const r = await run(FINAL_CAND, deps);
    check("B3-exhausted-giveup-winner-report",
      calls.posts.length === 0 && calls.marks.length === 1 && calls.reports.length === 1 && r.gaveUp.length === 1,
      JSON.stringify(calls));
    check("B11-report-awaited", calls.reportSettled === true, "러너가 reportGiveUp 을 await 해야 한다");
  }
  {
    const states = new Map([["20260829LGLT0", st(SUMMARY_BACKFILL_MAX_ATTEMPTS, 1, true)]]);
    const { deps, calls } = makeDeps({ readAttemptStates: async () => ({ ok: true, states }) });
    await run(FINAL_CAND, deps);
    check("B3b-no-duplicate-giveup", calls.marks.length === 0 && calls.reports.length === 0 && calls.posts.length === 0, JSON.stringify(calls));
  }
  {
    // markGaveUp CAS 패배(다른 run 이 종결) → report 안 함 / DB 에러 → fail-open report.
    const states = new Map([["20260829LGLT0", st(SUMMARY_BACKFILL_MAX_ATTEMPTS, 1)]]);
    const { deps: dLose, calls: cLose } = makeDeps({
      readAttemptStates: async () => ({ ok: true, states }),
      markGaveUp: async () => ({ won: false, error: false }),
    });
    await run(FINAL_CAND, dLose);
    const { deps: dErr, calls: cErr } = makeDeps({
      readAttemptStates: async () => ({ ok: true, states }),
      markGaveUp: async () => ({ won: false, error: true }),
    });
    await run(FINAL_CAND, dErr);
    check("B3c-mark-cas-loser-silent-error-failopen",
      cLose.reports.length === 0 && cErr.reports.length === 1,
      `loserReports=${cLose.reports.length} errReports=${cErr.reports.length}`);
  }
  {
    const states = new Map([["20260829LGLT0", st(3, NOW - 60_000)]]);
    const { deps, calls } = makeDeps({ readAttemptStates: async () => ({ ok: true, states }) });
    const r = await run(FINAL_CAND, deps);
    check("B4-backoff-no-claim", r.backedOff.length === 1 && calls.posts.length === 0 && calls.claims.length === 0);
  }
  {
    const { deps, calls } = makeDeps({ readAttemptStates: async () => ({ ok: false, states: new Map() }) });
    const r = await run(FINAL_CAND, deps);
    check("B5-state-fail-close", r.failClosed === true && calls.posts.length === 0);
  }
  {
    const { deps, calls } = makeDeps({ claimAttempt: async () => ({ ok: false, won: false }) });
    const r = await run(FINAL_CAND, deps);
    check("B6-claim-error-no-post", calls.posts.length === 0 && r.failClosed === true);
  }
  {
    const { deps, calls } = makeDeps({ claimAttempt: async () => ({ ok: true, won: false }) });
    const r = await run(FINAL_CAND, deps);
    check("B8-cas-lost-no-post", calls.posts.length === 0 && r.casLost.length === 1, JSON.stringify(r.casLost));
  }
  {
    // starvation 부재(삼순 재리뷰 ①): 앞 3경기가 backoff/gave-up 이어도 뒤 final 이 발사된다.
    const five = ["LGLT", "SSHT", "OBWO", "NCHH", "KTSS"].map((c) => ({ gameId: `20260829${c}0`, gameStateSc: "3" }));
    const states = new Map([
      ["20260829LGLT0", st(3, NOW - 60_000)],
      ["20260829SSHT0", st(3, NOW - 60_000)],
      ["20260829OBWO0", st(SUMMARY_BACKFILL_MAX_ATTEMPTS, 1, true)],
    ]);
    const { deps, calls } = makeDeps({ readAttemptStates: async () => ({ ok: true, states }) });
    await run(five, deps);
    check("B9-no-starvation",
      calls.posts.includes("20260829NCHH0") && calls.posts.includes("20260829KTSS0") && calls.posts.length === 2,
      `posts=${calls.posts}`);
  }
  {
    // 발사 cap 은 attempt 에만 (fresh 5경기 → 3발사).
    const five = ["LGLT", "SSHT", "OBWO", "NCHH", "KTSS"].map((c) => ({ gameId: `20260829${c}0`, gameStateSc: "3" }));
    const { deps, calls } = makeDeps();
    await run(five, deps);
    check("B12-launch-cap", calls.posts.length === SUMMARY_BACKFILL_MAX_PER_TICK, `posts=${calls.posts.length}`);
  }
  {
    // 동시 2-run(삼순 재리뷰 ②): 둘 다 stale state(attempts=0)를 읽어도 공유 CAS 가 1발사만 허용.
    const store = new Map(); // game_id -> attempts
    const casDeps = () =>
      makeDeps({
        claimAttempt: async (gameId, expected) => {
          const cur = store.get(gameId) ?? 0;
          if (cur !== expected) return { ok: true, won: false };
          store.set(gameId, cur + 1);
          return { ok: true, won: true };
        },
      });
    const a = casDeps();
    const b = casDeps();
    const [ra, rb] = await Promise.all([run(FINAL_CAND, a.deps), run(FINAL_CAND, b.deps)]);
    const totalPosts = a.calls.posts.length + b.calls.posts.length;
    const totalCasLost = ra.casLost.length + rb.casLost.length;
    check("B10-concurrent-two-run-single-launch", totalPosts === 1 && totalCasLost === 1,
      `posts=${totalPosts} casLost=${totalCasLost}`);
  }
}

// ===== W축: 배선(소스 구조 검사, 주석 blank) =====
function runWiringChecks() {
  const warmup = stripComments(readFileSync(path.join(ROOT, "src/app/api/cron/game-events-warmup/route.ts"), "utf8"));
  check("W1a-warmup-runs-runner", /const summaryBackfillPromise = runSummaryBackfill\(/.test(warmup));
  check("W1b-warmup-immediate-not-deferred", /after\(summaryBackfillPromise\)/.test(warmup) && !/after\(async \(\) =>[\s\S]{0,400}runSummaryBackfill/.test(warmup),
    "러너는 즉시 시작하고 after 에는 promise 만 넘겨야 한다");
  check("W1c-warmup-durable-state-wired", /from\(\s*"game_summary_backfill_state"\s*\)/.test(warmup));
  check("W1d-warmup-giveup-alert-awaited", /await trackApiDegradation\(/.test(warmup) && /classifyGenerationFailure\(\s*"backfill-exhausted"\s*\)/.test(warmup));
  check("W1e-warmup-claim-cas", /\.eq\("attempts", expectedAttempts\)/.test(warmup) && /"23505"/.test(warmup));
  check("W1f-warmup-mark-cas", /\.eq\("gave_up", false\)/.test(warmup));

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
    ["M4-drop-cap-param", FT, "if (out.length >= maxPerTick) break;", "", teamsRw,
      (mod) => runContractChecks({ select: mod.selectSummaryBackfillGames }), ["S5-cap-parameter"]],
    ["M5-drop-max-attempts", FT, 'if (attempts >= maxAttempts) return "exhausted";', "", teamsRw,
      (mod) => runRetryChecks({ decide: mod.backfillRetryDecision }), ["R6-max-attempts-exhausted"]],
    ["M6-zero-backoff", FT, "if (attempts <= 5) return 4 * 60_000;", "if (attempts <= 5) return 0;", teamsRw,
      (mod) => runRetryChecks({ decide: mod.backfillRetryDecision }), ["R3-fourth-attempt-4min-held"]],
    ["M7-benign-routed-to-alert", FO, "apiName: GENERATION_CONTENTION_API,", "apiName: GENERATION_ALERT_API,", [],
      (mod) => runObservabilityChecks({ classify: mod.classifyGenerationFailure }), ["O1-benign-contention-non-alerting"]],
    ["M8-drop-giveup-dedupe", BR, "if (state.gaveUp) continue;", "", ftRw,
      (mod) => runBehaviorChecks({ run: mod.runSummaryBackfill }), ["B3b-no-duplicate-giveup"]],
    ["M9-drop-launch-cap", BR, "if (result.launched.length >= SUMMARY_BACKFILL_MAX_PER_TICK) continue;", "", ftRw,
      (mod) => runBehaviorChecks({ run: mod.runSummaryBackfill }), ["B12-launch-cap"]],
    ["M10-ignore-cas-loss", BR, "if (!claim.won) {", "if (false) {", ftRw,
      (mod) => runBehaviorChecks({ run: mod.runSummaryBackfill }), ["B8-cas-lost-no-post", "B10-concurrent-two-run-single-launch"]],
    ["M11-drop-mark-failopen", BR, "if (mark.won || mark.error) {", "if (mark.won) {", ftRw,
      (mod) => runBehaviorChecks({ run: mod.runSummaryBackfill }), ["B3c-mark-cas-loser-silent-error-failopen"]],
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
