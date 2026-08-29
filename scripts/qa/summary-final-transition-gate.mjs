#!/usr/bin/env node
/**
 * summary-final-transition-gate (npm run qa:summary-final-transition / :selftest)
 *
 * 계약 (2026-08-29 #cs "경기요약 안됨" — LG:롯데 7회 강우콜드 인시던트):
 * KBO 가 콜드게임 final 전이를 실플레이 중단 후 ~1h40m 늦게 내려줬고(20:43→22:21),
 * prewarm 크론(매시 :15)의 최대 60분 공백 때문에 유저가 종료 화면에서 요약 없음을 봤다.
 *
 *  F1. final 지연 구간(status=live) replay — canonicalGate 는 not-final 로 fail-close.
 *      (요약을 미리 만들면 안 된다: 실제로 21:33 재개 활동이 있었다.)
 *  F2. 7회 콜드 확정 replay — status=final + R 교차일치면 이닝 수와 무관하게 ok.
 *      fingerprint 이닝 길이 = 7 (이닝수 9 하드코딩 회귀 차단).
 *  F3. canonical 불일치 — 게임목록 스코어 ≠ 스코어보드 R 이면 canonical-not-settled.
 *  F4. 스코어보드 부재/cancelled — canonical-not-settled(fail-close).
 *  F5. canonical race — 생성 시점 fingerprint 와 저장 직전 fingerprint 가 다르면 저장 거부.
 *  S1~S6. 백필 선정(selectSummaryBackfillGames): final+row없음만 선정 / live 제외 /
 *      row존재 제외 / 상태미상 제외(fail-close) / per-tick 상한 / 올스타 제외(영구루프 방지).
 *  W1. 배선 — warmup 크론이 실제로 selectSummaryBackfillGames 를 부르고 game_summaries
 *      존재 조회 + /api/game-summary POST 를 발사한다(주석 blank 후 구조 검사).
 *  W2. 배선 — game-summary POST 의 터미널 실패 exit 들이 reportGenerationFailure 를 거쳐
 *      trackApiDegradation("game-summary-generation") durable 기록으로 이어진다.
 *
 * 순수 판정(F/S축)은 production seam 과 *같은 함수*를 import 해 직접 실행한다.
 * --selftest: 실제 소스 변이(mutation) 재실행으로 S축 검증력이 RED 를 낼 수 있음을 증명.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalGate, createSummaryFingerprint, shouldSaveGeneratedSummary } from "../../src/lib/game-summary/cache-validation";
import {
  selectSummaryBackfillGames,
  KBO_GAME_STATE_FINAL,
  SUMMARY_BACKFILL_MAX_PER_TICK,
} from "../../src/lib/game-summary/final-transition";

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
const LGLT_AWAY_INNINGS = [0, 3, 0, 0, 5, 0, 0]; // LG 8득점? (R 합=8: 2회 3점+5회 5점)
const LGLT_HOME_INNINGS = [0, 1, 1, 0, 0, 1, 0]; // 롯데 3점
const lgltLinescoreFinal = {
  status: "final",
  away: { R: 8, innings: [...LGLT_AWAY_INNINGS] },
  home: { R: 3, innings: [...LGLT_HOME_INNINGS] },
};

function runContractChecks({ select }) {
  // ----- F축: canonicalGate replay -----
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

  // ----- S축: 백필 선정 -----
  const existing = new Set(["20260829KTSS0"]);
  const candidates = [
    { gameId: "20260829LGLT0", gameStateSc: KBO_GAME_STATE_FINAL }, // final + row 없음 → 선정
    { gameId: "20260829NCHH0", gameStateSc: "2" },                  // live → 제외
    { gameId: "20260829KTSS0", gameStateSc: KBO_GAME_STATE_FINAL }, // row 존재 → 제외
    { gameId: "20260829WOOB0", gameStateSc: null },                 // 상태 미상 → 제외(fail-close)
    { gameId: "20260717EWWE0", gameStateSc: KBO_GAME_STATE_FINAL }, // 올스타 → 제외(영구루프 방지)
  ];
  const picked = select(candidates, existing);
  check("S1-final-missing-selected", picked.includes("20260829LGLT0"), `picked=${picked}`);
  check("S2-live-excluded", !picked.includes("20260829NCHH0"), `picked=${picked}`);
  check("S3-existing-excluded", !picked.includes("20260829KTSS0"), `picked=${picked}`);
  check("S4-unknown-state-excluded", !picked.includes("20260829WOOB0"), `picked=${picked}`);
  check("S6-allstar-excluded", !picked.includes("20260717EWWE0"), `picked=${picked}`);

  const many = ["A", "B", "C", "D", "E"].map((c, i) => ({
    gameId: `20260829LG${"LTSSHTOBWO".slice(i * 2, i * 2 + 2)}0`,
    gameStateSc: KBO_GAME_STATE_FINAL,
  }));
  const capped = select(many, new Set());
  check("S5-per-tick-cap", capped.length === SUMMARY_BACKFILL_MAX_PER_TICK,
    `len=${capped.length} cap=${SUMMARY_BACKFILL_MAX_PER_TICK}`);
}

// ===== W축: 배선(소스 구조 검사, 주석 blank) =====
function runWiringChecks() {
  const warmup = stripComments(readFileSync(path.join(ROOT, "src/app/api/cron/game-events-warmup/route.ts"), "utf8"));
  check("W1a-warmup-calls-selector", /selectSummaryBackfillGames\s*\(/.test(warmup));
  check("W1b-warmup-existence-query", /from\(\s*"game_summaries"\s*\)/.test(warmup));
  check("W1c-warmup-posts-summary", /\/api\/game-summary`/.test(warmup) && /method:\s*"POST"/.test(warmup));
  check("W1d-warmup-failclose-on-query-error", /error\)\s*\{[\s\S]{0,200}?return;/.test(warmup));

  const route = stripComments(readFileSync(path.join(ROOT, "src/app/api/game-summary/route.ts"), "utf8"));
  const reportCalls = (route.match(/reportGenerationFailure\(/g) || []).length;
  // 헬퍼 정의 1 + 터미널 exit 11곳(claim/gemini-api/empty/parse×2/score/winner/consistency/race/save/exception)
  check("W2a-failure-exits-wired", reportCalls >= 12, `reportGenerationFailure calls=${reportCalls} (need ≥12)`);
  check("W2b-durable-sink", /trackApiDegradation\(\s*\n?\s*"game-summary-generation"/.test(route));
}

// ===== selftest: 실제 소스 변이로 S축 검증력 증명 =====
async function runSelftest() {
  const src = readFileSync(path.join(ROOT, "src/lib/game-summary/final-transition.ts"), "utf8");
  const teamsAbs = path.join(ROOT, "src/lib/constants/teams").replace(/\\/g, "/");
  const mutations = [
    ["M1-drop-existing-check", "if (existingSummaryIds.has(c.gameId)) continue;", "", ["S3-existing-excluded"]],
    ["M2-drop-state-check", "if (c.gameStateSc !== KBO_GAME_STATE_FINAL) continue;", "", ["S2-live-excluded"]],
    ["M3-drop-allstar-check", "if (isAllStarGameId(c.gameId)) continue;", "", ["S6-allstar-excluded"]],
    ["M4-drop-cap", "if (out.length >= maxPerTick) break;", "", ["S5-per-tick-cap"]],
  ];
  const dir = mkdtempSync(path.join(tmpdir(), "summary-gate-"));
  let allCaught = true;
  try {
    for (const [id, needle, replacement, expectFail] of mutations) {
      if (!src.includes(needle)) {
        console.log(`  FAIL  ${id} — mutation target not found (패치 미적용 = FAIL)`);
        allCaught = false;
        continue;
      }
      const mutated = src
        .replace(needle, replacement)
        .replace("@/lib/constants/teams", teamsAbs);
      const file = path.join(dir, `${id}.ts`);
      writeFileSync(file, mutated);
      const mod = await import(file);
      const before = failures.length;
      runContractChecks({ select: (c, e) => mod.selectSummaryBackfillGames(c, e) });
      const newFails = failures.splice(before); // selftest 실패는 본판정에 안 섞는다
      const caught = expectFail.every((f) => newFails.includes(f));
      console.log(`  ${caught ? "PASS" : "FAIL"}  selftest:${id} — mutation ${caught ? "detected(RED)" : "NOT detected"}`);
      if (!caught) allCaught = false;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return allCaught;
}

console.log("summary-final-transition-gate");
if (SELFTEST) {
  const ok = await runSelftest();
  console.log(ok ? "SELFTEST GREEN — all mutations detected" : "SELFTEST RED — verification power missing");
  process.exit(ok ? 0 : 1);
} else {
  runContractChecks({ select: (c, e) => selectSummaryBackfillGames(c, e) });
  runWiringChecks();
  if (failures.length > 0) {
    console.log(`\nRED — ${failures.length} failure(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nGREEN — all contracts hold");
}
