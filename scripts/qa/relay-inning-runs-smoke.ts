/**
 * Regression smoke for `inningRuns` (2026-07-27).
 *
 * Why
 * ---
 * 경기 기록 이닝별 카드 우측 상단 점수(`{scores}점`)가 relay 문구 추정
 * (countScoring: `홈까지 진루` / `득점` 포함 건수 + 홈런 수)으로 계산돼,
 * 실제 원문이 `홈인`이면 누락되고 주자 있는 홈런도 최소 1점만 잡혀
 * "무조건 1점"처럼 보이는 버그(파도 제보, Android v1.0.16).
 * Production 7/26 LG-한화: 실제 4회말 3점 → 추정 0, 8회말 10점 → 추정 3.
 *
 * Fix: 추정 카운트를 버리고 응답에 이미 있는 linescore.away/home.innings[n-1]를
 *      해당 초/말 카드에 그대로 연결한다.
 *
 * Assertions
 * ----------
 *   T1: top(초) → away.innings[n-1] 반환.
 *   T2: bottom(말) → home.innings[n-1] 반환 (7/26 8회말 10점 재현).
 *   T3: 실제 득점 0인 이닝(무득점) → 0 반환 (undefined/폴백 아님).
 *   T4: linescore 없음 → undefined (카드가 추정카운트 폴백).
 *   T5: linescore 있으나 해당 이닝 배열 밖 → undefined.
 *   T6: 해당 이닝 값이 null(미기록) → undefined.
 */

import { inningRuns } from "../../src/lib/game/inning-runs";
import type { GameRelayResponse, InningRelay } from "../../src/app/api/game-relay/route";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.error(`  \u2717 ${name}`);
  }
}

function inning(inn: number, half: "top" | "bottom"): InningRelay {
  return { inning: inn, half, teamName: "", plays: [] } as unknown as InningRelay;
}

// 7/26 LG(away)-한화(home) 재현: away 1회초 0..., home 4회말 3점, 8회말 10점
const relay: GameRelayResponse = {
  gameId: "20260726LGHH0",
  currentInning: 8,
  innings: [],
  linescore: {
    away: { innings: [1, 0, 0, 0, 0, 0, 0, 0], R: 4, H: 8, E: 0 },
    home: { innings: [0, 0, 0, 3, 0, 0, 0, 10], R: 14, H: 15, E: 0 },
  },
} as unknown as GameRelayResponse;

console.log("\u2014 T1: top(\ucd08) \u2192 away.innings[n-1]");
assert("1\ud68c\ucd08 = 1", inningRuns(relay, inning(1, "top")) === 1);

console.log("\u2014 T2: bottom(\ub9d0) \u2192 home.innings[n-1] (8\ud68c\ub9d0 10\uc810)");
assert("8\ud68c\ub9d0 = 10 (\ucd94\uc815 3\uc774 \uc544\ub2cc \uc2e4\uc81c 10)", inningRuns(relay, inning(8, "bottom")) === 10);
assert("4\ud68c\ub9d0 = 3 (\ucd94\uc815 0\uc774 \uc544\ub2cc \uc2e4\uc81c 3)", inningRuns(relay, inning(4, "bottom")) === 3);

console.log("\u2014 T3: \ubb34\ub4dd\uc810 \uc774\ub2dd \u2192 0 (undefined \uc544\ub2d8)");
assert("2\ud68c\ucd08 = 0", inningRuns(relay, inning(2, "top")) === 0);

console.log("\u2014 T4: linescore \uc5c6\uc74c \u2192 undefined (\ud3f4\ubc31)");
const noLs = { gameId: "x", currentInning: 1, innings: [] } as unknown as GameRelayResponse;
assert("undefined", inningRuns(noLs, inning(1, "top")) === undefined);
assert("relay null \u2192 undefined", inningRuns(null, inning(1, "top")) === undefined);

console.log("\u2014 T5: \ubc30\uc5f4 \ubc16 \uc774\ub2dd \u2192 undefined");
assert("9\ud68c\ucd08(\ubbf8\uae30\ub85d) = undefined", inningRuns(relay, inning(9, "top")) === undefined);

console.log("\u2014 T6: \ud574\ub2f9 \uc774\ub2dd null \u2192 undefined");
const withNull = {
  ...relay,
  linescore: {
    away: { innings: [null], R: 0, H: 0, E: 0 },
    home: { innings: [null], R: 0, H: 0, E: 0 },
  },
} as unknown as GameRelayResponse;
assert("1\ud68c\ucd08 null = undefined", inningRuns(withNull, inning(1, "top")) === undefined);

console.log("");
if (fail > 0) {
  console.error(`\u274c FAIL \u2014 ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`\u2705 PASS \u2014 ${pass} assertions, 0 failures`);
