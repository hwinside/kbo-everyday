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
 * Component/UI assertions cover 4회말 3점, 8회말 10점, 0점, linescore 없음,
 * null, 10회+, and scoring-looking relay text without a linescore.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RelayInningCard from "../../src/components/game/RelayInningCard";
import { inningRuns } from "../../src/lib/game/inning-runs";
import type { GameRelayResponse, InningRelay } from "../../src/app/api/game-relay/route";
import type { TeamData } from "../../src/lib/constants/teams";

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

function inning(
  inn: number,
  half: "top" | "bottom",
  scoringLookingText = false,
): InningRelay {
  return {
    inning: inn,
    half,
    teamName: half === "top" ? "LG" : "한화",
    plays: scoringLookingText
      ? [{
          batterName: "테스트",
          result: "주자 진루",
          type: "other",
          extras: ["1루주자 홈까지 진루", "득점"],
        }]
      : [],
  };
}

const awayTeam = {
  id: 1,
  name: "LG 트윈스",
  shortName: "LG",
  colorPrimary: "#C60C30",
} as TeamData;
const homeTeam = {
  id: 10,
  name: "한화 이글스",
  shortName: "한화",
  colorPrimary: "#FF6600",
} as TeamData;

function renderCard(
  linescore: GameRelayResponse["linescore"] | null | undefined,
  targetInning: InningRelay,
): string {
  return renderToStaticMarkup(
    React.createElement(RelayInningCard, {
      inning: targetInning,
      awayTeam,
      homeTeam,
      runs: inningRuns(linescore, targetInning),
    }),
  );
}

function hasBadge(markup: string): boolean {
  return markup.includes("ml-auto text-xs font-bold");
}

// 7/26 LG(away)-한화(home) 재현 + 연장 10회
const linescore = {
  away: { innings: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], R: 4, H: 8, E: 0 },
  home: { innings: [0, 0, 0, 3, 0, 0, 0, 10, 0, 2], R: 16, H: 15, E: 0 },
};

console.log("— UI: linescore 실값 배지");
const fourthBottom = renderCard(linescore, inning(4, "bottom"));
assert("4회말 카드 = 3점", hasBadge(fourthBottom) && fourthBottom.includes(">3점<"));
const eighthBottom = renderCard(linescore, inning(8, "bottom"));
assert("8회말 카드 = 10점", hasBadge(eighthBottom) && eighthBottom.includes(">10점<"));
const tenthBottom = renderCard(linescore, inning(10, "bottom"));
assert("10회말 카드 = 2점", hasBadge(tenthBottom) && tenthBottom.includes(">2점<"));

console.log("— UI: 0/없음/null은 배지 숨김");
assert("0점 이닝 배지 없음", !hasBadge(renderCard(linescore, inning(2, "top"))));
assert(
  "linescore 없음 + 득점 문구도 배지 없음",
  !hasBadge(renderCard(undefined, inning(1, "top", true))),
);

const withNull = {
  away: { innings: [null], R: 0, H: 0, E: 0 },
  home: { innings: [null], R: 0, H: 0, E: 0 },
};
assert(
  "null 이닝 + 득점 문구도 배지 없음",
  !hasBadge(renderCard(withNull, inning(1, "bottom", true))),
);
assert(
  "배열 밖 11회 + 득점 문구도 배지 없음",
  !hasBadge(renderCard(linescore, inning(11, "bottom", true))),
);

console.log("");
if (fail > 0) {
  console.error(`\u274c FAIL \u2014 ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`\u2705 PASS \u2014 ${pass} assertions, 0 failures`);
