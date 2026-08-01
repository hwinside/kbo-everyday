/**
 * 요정 지수 pregame 기대치 회귀 — 삼순 2026-08-02 지정 항목.
 *
 *  - 강/약팀 × 홈/원정 반대 사례: 같은 결과라도 상대전력·홈원정에 따라 부호가 갈려야 한다.
 *  - 박빙패 residual 양/음 경계: 1점패가 자동 플러스가 아님을 고정.
 *  - leakage: 대상 경기 당일/이후 데이터가 기대치에 섞이면 안 된다.
 *  - pregame 표본 미달 → 기대치 없음(지수 전체 fail-close).
 *
 * 모든 케이스는 raw 경기 입력을 실제 `computeExcessPerformance`/`pregameExpectation` 에
 * 통과시킨다(초과성과 값을 직접 주입하지 않는다 — 그게 이전 회귀의 구멍이었다).
 */
import assert from "node:assert/strict";

import {
  computeExcessPerformance,
  pregameExpectation,
  MIN_PRIOR_GAMES,
} from "../../src/lib/venue-stats/expected";
import type { SeasonGameVerification } from "../../src/lib/venue-stats/aggregate";

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const STRONG = 1; // 강팀
const WEAK = 2; // 약팀
const NEUTRAL = 3;

/** 지정 승수/득실로 pregame 우주를 만든다. 날짜는 전부 대상 경기 이전. */
function priorGames(
  spec: Array<{ teamId: number; wins: number; losses: number; runsFor: number; runsAgainst: number }>,
): SeasonGameVerification[] {
  const games: SeasonGameVerification[] = [];
  let day = 1;
  for (const team of spec) {
    // 상대는 항상 NEUTRAL 이 아닌 더미(9)로 두어 대상 팀 기록만 통제한다.
    const filler = 9;
    for (let i = 0; i < team.wins; i += 1) {
      games.push({
        gameId: `2026060${day % 10}X${team.teamId}W${i}`,
        gameDate: `2026-05-${String((day % 28) + 1).padStart(2, "0")}`,
        complete: true,
        teamCodes: [],
        awayTeamId: team.teamId,
        homeTeamId: filler,
        awayScore: Math.round(team.runsFor / Math.max(team.wins + team.losses, 1)) + 2,
        homeScore: Math.round(team.runsAgainst / Math.max(team.wins + team.losses, 1)),
      });
      day += 1;
    }
    for (let i = 0; i < team.losses; i += 1) {
      games.push({
        gameId: `2026060${day % 10}X${team.teamId}L${i}`,
        gameDate: `2026-05-${String((day % 28) + 1).padStart(2, "0")}`,
        complete: true,
        teamCodes: [],
        awayTeamId: team.teamId,
        homeTeamId: filler,
        awayScore: Math.round(team.runsFor / Math.max(team.wins + team.losses, 1)),
        homeScore: Math.round(team.runsAgainst / Math.max(team.wins + team.losses, 1)) + 2,
      });
      day += 1;
    }
  }
  return games;
}

// 강팀(승률 .750, 득실 +2.0) / 약팀(승률 .250, 득실 −2.0) / 중립(.500, 0)
const universe = priorGames([
  { teamId: STRONG, wins: 15, losses: 5, runsFor: 120, runsAgainst: 80 },
  { teamId: WEAK, wins: 5, losses: 15, runsFor: 80, runsAgainst: 120 },
  { teamId: NEUTRAL, wins: 10, losses: 10, runsFor: 100, runsAgainst: 100 },
]);

const TARGET_DATE = "2026-07-01";

console.log("venue stats — pregame 기대치 / 초과성과");

// ── ① 기대치 자체: 강팀 상대는 기대가 낮고, 홈이면 조금 오른다 ────────────────
{
  const vsStrongAway = pregameExpectation(universe, {
    gameDate: TARGET_DATE, myTeamId: WEAK, opponentTeamId: STRONG, isHome: false,
  });
  const vsWeakHome = pregameExpectation(universe, {
    gameDate: TARGET_DATE, myTeamId: STRONG, opponentTeamId: WEAK, isHome: true,
  });
  ok(
    "약팀이 강팀 원정 → 기대승률 < .5, 기대마진 < 0",
    vsStrongAway != null && vsStrongAway.expectedWinProb < 0.5 && vsStrongAway.expectedMargin < 0,
    JSON.stringify(vsStrongAway),
  );
  ok(
    "강팀이 약팀 홈 → 기대승률 > .5, 기대마진 > 0",
    vsWeakHome != null && vsWeakHome.expectedWinProb > 0.5 && vsWeakHome.expectedMargin > 0,
    JSON.stringify(vsWeakHome),
  );

  const home = pregameExpectation(universe, {
    gameDate: TARGET_DATE, myTeamId: NEUTRAL, opponentTeamId: NEUTRAL, isHome: true,
  })!;
  const away = pregameExpectation(universe, {
    gameDate: TARGET_DATE, myTeamId: NEUTRAL, opponentTeamId: NEUTRAL, isHome: false,
  })!;
  ok(
    "동일 전력이면 홈 기대가 원정보다 높다(홈 어드밴티지)",
    home.expectedWinProb > away.expectedWinProb && home.expectedMargin > away.expectedMargin,
    `${home.expectedWinProb} vs ${away.expectedWinProb}`,
  );
}

/** 한 경기짜리 초과성과 계산 헬퍼. */
function excessOf(params: {
  myTeamId: number;
  opponentTeamId: number;
  isHome: boolean;
  result: "W" | "L" | "D";
  myScore: number;
  oppScore: number;
}) {
  const list = computeExcessPerformance(universe, [{
    gameId: "target", gameDate: TARGET_DATE, ...params,
  }]);
  return list?.[0] ?? null;
}

// ── ② 핵심 RED: 1점차 패는 자동 플러스가 아니다 ─────────────────────────────
{
  // 약팀이 강팀 원정에서 1점차 패 → 기대(대패)보다 잘함 → 마진 초과 플러스
  const underdogCloseLoss = excessOf({
    myTeamId: WEAK, opponentTeamId: STRONG, isHome: false,
    result: "L", myScore: 3, oppScore: 4,
  })!;
  // 강팀이 약팀 홈에서 1점차 패 → 기대(낙승)보다 훨씬 못함 → 마진 초과 마이너스
  const favoriteCloseLoss = excessOf({
    myTeamId: STRONG, opponentTeamId: WEAK, isHome: true,
    result: "L", myScore: 3, oppScore: 4,
  })!;

  ok(
    "약팀이 강팀 원정 1점패 → 마진 초과 플러스(기대보다 잘함)",
    underdogCloseLoss.marginExcess > 0,
    `${underdogCloseLoss.marginExcess}`,
  );
  ok(
    "강팀이 약팀 홈 1점패 → 마진 초과 마이너스(자동 플러스 아님)",
    favoriteCloseLoss.marginExcess < 0,
    `${favoriteCloseLoss.marginExcess}`,
  );
  ok(
    "동일한 1점패라도 상대전력·홈원정으로 부호가 갈린다",
    underdogCloseLoss.marginExcess > 0 && favoriteCloseLoss.marginExcess < 0,
  );

  // 승리도 같은 규칙 — 강팀이 약팀 상대 1점차 신승이면 승점은 넘어도 마진은 기대 이하일 수 있다.
  const favoriteNarrowWin = excessOf({
    myTeamId: STRONG, opponentTeamId: WEAK, isHome: true,
    result: "W", myScore: 4, oppScore: 3,
  })!;
  const underdogBlowoutWin = excessOf({
    myTeamId: WEAK, opponentTeamId: STRONG, isHome: false,
    result: "W", myScore: 9, oppScore: 2,
  })!;
  ok(
    "강팀 약팀상대 신승 < 약팀 강팀원정 대승 (승리 초과성과)",
    underdogBlowoutWin.winExcess > favoriteNarrowWin.winExcess,
    `${underdogBlowoutWin.winExcess} vs ${favoriteNarrowWin.winExcess}`,
  );
  ok(
    "강팀 약팀상대 신승은 기대 마진에 못 미쳐 마진 초과가 음수일 수 있다",
    favoriteNarrowWin.marginExcess < underdogBlowoutWin.marginExcess,
    `${favoriteNarrowWin.marginExcess} vs ${underdogBlowoutWin.marginExcess}`,
  );
}

// ── ③ 같은 마진 5점패라도 기대에 따라 다르다 ────────────────────────────────
{
  const underdogBigLoss = excessOf({
    myTeamId: WEAK, opponentTeamId: STRONG, isHome: false,
    result: "L", myScore: 1, oppScore: 6,
  })!;
  const underdogCloseLoss = excessOf({
    myTeamId: WEAK, opponentTeamId: STRONG, isHome: false,
    result: "L", myScore: 3, oppScore: 4,
  })!;
  ok(
    "같은 약팀·같은 상대라면 1점패가 5점패보다 초과성과가 높다",
    underdogCloseLoss.marginExcess > underdogBigLoss.marginExcess,
    `${underdogCloseLoss.marginExcess} vs ${underdogBigLoss.marginExcess}`,
  );
}

// ── ④ leakage RED: 대상 경기 당일/이후 데이터는 기대치에 섞이면 안 된다 ────────
{
  // 대상 경기일 당일에 강팀이 대패한 기록을 넣어도 기대치는 변하면 안 된다.
  const leaky: SeasonGameVerification[] = [
    ...universe,
    {
      gameId: "leak-sameday", gameDate: TARGET_DATE, complete: true, teamCodes: [],
      awayTeamId: STRONG, homeTeamId: WEAK, awayScore: 0, homeScore: 20,
    },
    {
      gameId: "leak-future", gameDate: "2026-09-01", complete: true, teamCodes: [],
      awayTeamId: STRONG, homeTeamId: WEAK, awayScore: 0, homeScore: 20,
    },
  ];
  const base = pregameExpectation(universe, {
    gameDate: TARGET_DATE, myTeamId: WEAK, opponentTeamId: STRONG, isHome: false,
  })!;
  const withLeak = pregameExpectation(leaky, {
    gameDate: TARGET_DATE, myTeamId: WEAK, opponentTeamId: STRONG, isHome: false,
  })!;
  ok(
    "대상 경기 당일·이후 결과는 기대치에 영향 없음(leakage 차단)",
    Math.abs(base.expectedWinProb - withLeak.expectedWinProb) < 1e-12 &&
      Math.abs(base.expectedMargin - withLeak.expectedMargin) < 1e-12,
    `${JSON.stringify(base)} vs ${JSON.stringify(withLeak)}`,
  );

  // 반대로 경기일 *이전* 기록이 늘면 기대치는 반드시 변해야 한다(가드가 과잉 차단이 아님을 증명).
  // ⚠️ WEAK vs STRONG 은 기대 마진이 이미 상한(MAX_EXPECTED_MARGIN)에 걸려 있어 변화가 안 보인다.
  //    상한에 눌리지 않는 중립 매치업으로 대조해야 "갱신되는가"를 실제로 검증할 수 있다.
  const neutralBase = pregameExpectation(universe, {
    gameDate: TARGET_DATE, myTeamId: NEUTRAL, opponentTeamId: WEAK, isHome: true,
  })!;
  const priorAdded: SeasonGameVerification[] = [
    ...universe,
    {
      gameId: "prior-extra", gameDate: "2026-06-30", complete: true, teamCodes: [],
      awayTeamId: NEUTRAL, homeTeamId: 9, awayScore: 12, homeScore: 0,
    },
  ];
  const withPrior = pregameExpectation(priorAdded, {
    gameDate: TARGET_DATE, myTeamId: NEUTRAL, opponentTeamId: WEAK, isHome: true,
  })!;
  ok(
    "경기일 이전 기록이 늘면 기대치는 실제로 갱신된다(과잉 차단 아님)",
    Math.abs(withPrior.expectedMargin - neutralBase.expectedMargin) > 1e-9 &&
      Math.abs(withPrior.expectedWinProb - neutralBase.expectedWinProb) > 1e-9,
    `${withPrior.expectedMargin} vs ${neutralBase.expectedMargin}`,
  );
}

// ── ⑤ pregame 표본 미달 → 기대치 없음 → 초과성과 전체 null (지수 fail-close) ──
{
  const thin = priorGames([
    { teamId: STRONG, wins: 1, losses: 1, runsFor: 8, runsAgainst: 8 },
    { teamId: WEAK, wins: 1, losses: 1, runsFor: 8, runsAgainst: 8 },
  ]);
  const expectation = pregameExpectation(thin, {
    gameDate: TARGET_DATE, myTeamId: WEAK, opponentTeamId: STRONG, isHome: false,
  });
  ok(`양 팀 pregame < ${MIN_PRIOR_GAMES}경기면 기대치 없음`, expectation === null);

  // 한 경기라도 기대치를 못 만들면 전체 null — 축 재정규화로 덮지 않는다(삼순 P0).
  const mixed = computeExcessPerformance(universe, [
    {
      gameId: "ok", gameDate: TARGET_DATE, myTeamId: WEAK, opponentTeamId: STRONG,
      isHome: false, result: "W", myScore: 5, oppScore: 4,
    },
    {
      // 로스터에 없는 팀(pregame 기록 0) — 기대치 산출 불가
      gameId: "unknown-team", gameDate: TARGET_DATE, myTeamId: 99, opponentTeamId: STRONG,
      isHome: true, result: "W", myScore: 5, oppScore: 4,
    },
  ]);
  ok("한 경기라도 기대치 불가면 초과성과 전체 null(부분 산출 금지)", mixed === null);

  // 필수 필드 결손도 동일하게 전체 null.
  const missingField = computeExcessPerformance(universe, [{
    gameId: "no-score", gameDate: TARGET_DATE, myTeamId: WEAK, opponentTeamId: STRONG,
    isHome: false, result: "L", myScore: null, oppScore: 4,
  }]);
  ok("스코어 결손 경기가 있으면 초과성과 전체 null", missingField === null);
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
assert.equal(fail, 0);
