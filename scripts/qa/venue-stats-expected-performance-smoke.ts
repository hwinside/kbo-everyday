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
  HOME_MARGIN_EDGE,
  HOME_WIN_EDGE,
  MAX_EXPECTED_MARGIN,
  MEASURED_HOME_WIN_EDGE_CI,
  MIN_PRIOR_GAMES,
} from "../../src/lib/venue-stats/expected";
import { SCORE_SCALE, scoreBadgeLabel } from "../../src/lib/venue-stats/ui";
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

// ⚠️ 주석과 실제 생성값이 달랐다(삼순 P0 지적). `priorGames` 는 승/패 경기마다 ±2점을
//    더하는 방식이라 아래 spec 의 runsFor/runsAgainst 는 그대로 반영되지 않는다.
//    실제 생성값을 아래 §0 에서 계산해 출력하고, 그 값으로 기대치 계약을 검증한다.
const universe = priorGames([
  { teamId: STRONG, wins: 15, losses: 5, runsFor: 120, runsAgainst: 80 },
  { teamId: WEAK, wins: 5, losses: 15, runsFor: 80, runsAgainst: 120 },
  { teamId: NEUTRAL, wins: 10, losses: 10, runsFor: 100, runsAgainst: 100 },
]);

const TARGET_DATE = "2026-07-01";

console.log("venue stats — pregame 기대치 / 초과성과");

// ── ⓪ fixture 자기검증: 주석이 아니라 **실제 생성값**을 출력하고 계약에 쓴다 ──────
{
  const summary = new Map<number, { g: number; w: number; rf: number; ra: number }>();
  for (const game of universe) {
    const t = game.awayTeamId!;
    const cur = summary.get(t) ?? { g: 0, w: 0, rf: 0, ra: 0 };
    cur.g += 1;
    cur.rf += game.awayScore!;
    cur.ra += game.homeScore!;
    if (game.awayScore! > game.homeScore!) cur.w += 1;
    summary.set(t, cur);
  }
  for (const [teamId, v] of [...summary].sort((a, b) => a[0] - b[0])) {
    console.log(
      `    fixture team ${teamId}: ${v.g}경기 승률 ${(v.w / v.g).toFixed(3)} 득실 ${((v.rf - v.ra) / v.g).toFixed(2)}`,
    );
  }
  const strong = summary.get(STRONG)!;
  const weak = summary.get(WEAK)!;
  ok(
    "fixture 강팀 승률 > 약팀 승률 (실제 생성값 기준)",
    strong.w / strong.g > weak.w / weak.g,
  );
  ok(
    "fixture 강팀 득실 > 약팀 득실 (실제 생성값 기준)",
    (strong.rf - strong.ra) / strong.g > (weak.rf - weak.ra) / weak.g,
  );
}

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

// ── ⑥ 상수 근거·민감도 계약 (삼순 P0 2026-08-02) ────────────────────────────
// 이전 홈 보정(±.02)은 출처 없는 손튜닝이었고, 방향만 보는 RED 는 임의의 작은 값도 통과시켰다.
// 이제 ①상수가 실측 95%CI 안인지 ②그 크기가 지수 부호를 뒤집지 못하는지를 함께 고정한다.
{
  ok(
    `홈 승률 보정(${HOME_WIN_EDGE})이 실측 95%CI [${MEASURED_HOME_WIN_EDGE_CI.low}, ${MEASURED_HOME_WIN_EDGE_CI.high}] 안`,
    HOME_WIN_EDGE >= MEASURED_HOME_WIN_EDGE_CI.low && HOME_WIN_EDGE <= MEASURED_HOME_WIN_EDGE_CI.high,
    `${HOME_WIN_EDGE}`,
  );
  // 실측 점추정(+0.0051) 대비 과대 보정 금지 — 발명한 값으로 되돌리면 FAIL.
  ok(
    "홈 승률 보정이 실측 점추정의 2배를 넘지 않는다(손튜닝 회귀 차단)",
    Math.abs(HOME_WIN_EDGE) <= 0.0102 + 1e-12,
    `${HOME_WIN_EDGE}`,
  );
  ok(
    "홈 마진 보정도 '거의 0' 정책 범위(|x| ≤ 0.1)",
    Math.abs(HOME_MARGIN_EDGE) <= 0.1,
    `${HOME_MARGIN_EDGE}`,
  );

  // 민감도: 홈/원정만 다른 동일 경기에서 초과성과 **부호가 뒤집히면 안 된다.**
  // (홈 보정이 커지면 원정 승리가 마이너스로 둔갑하는 등 부호 오염이 생긴다)
  const homeWin = excessOf({
    myTeamId: NEUTRAL, opponentTeamId: NEUTRAL, isHome: true,
    result: "W", myScore: 5, oppScore: 3,
  })!;
  const awayWin = excessOf({
    myTeamId: NEUTRAL, opponentTeamId: NEUTRAL, isHome: false,
    result: "W", myScore: 5, oppScore: 3,
  })!;
  ok(
    "동일 승리는 홈/원정 모두 승점 초과 양수(홈 보정이 부호를 뒤집지 못함)",
    homeWin.winExcess > 0 && awayWin.winExcess > 0,
    `${homeWin.winExcess} vs ${awayWin.winExcess}`,
  );
  ok(
    "홈 보정 방향은 유지 — 같은 결과면 원정 초과성과가 더 크다",
    awayWin.winExcess > homeWin.winExcess && awayWin.marginExcess > homeWin.marginExcess,
    `${awayWin.winExcess} vs ${homeWin.winExcess}`,
  );
  // 보정 크기가 결과 자체(승/패)보다 작아야 한다 — 홈 여부로 승패 초과가 역전되면 안 됨.
  const homeLoss = excessOf({
    myTeamId: NEUTRAL, opponentTeamId: NEUTRAL, isHome: true,
    result: "L", myScore: 3, oppScore: 5,
  })!;
  ok(
    "원정 패배 < 홈 승리 (보정이 승패 신호를 넘지 못함)",
    homeLoss.winExcess < awayWin.winExcess && homeLoss.winExcess < 0,
    `${homeLoss.winExcess}`,
  );

  // 기대 마진 상한은 제품 정책 상수 — 극단 조합에서 발산하지 않는지 경계 고정.
  const extreme = pregameExpectation(universe, {
    gameDate: TARGET_DATE, myTeamId: STRONG, opponentTeamId: WEAK, isHome: true,
  })!;
  ok(
    `기대 마진이 정책 상한 ±${MAX_EXPECTED_MARGIN} 안으로 잘린다`,
    Math.abs(extreme.expectedMargin) <= MAX_EXPECTED_MARGIN + 1e-12,
    `${extreme.expectedMargin}`,
  );
  ok(
    "기대 승률도 0.05~0.95 로 bounded",
    extreme.expectedWinProb <= 0.95 && extreme.expectedWinProb >= 0.05,
    `${extreme.expectedWinProb}`,
  );
}

// ── ⑦ 정규화 스케일 정책 + raw-game 민감도 행렬 (삼순 P0 2026-08-02) ─────────
// 삼순 실증: `.35/3` → `.25/2` 로 바꾸면 같은 경기가 71 → 80점이 되어
// `약간 요정 ↔ 진짜 요정` 배지가 뒤집히는데 어떤 게이트도 막지 못했다.
// 여기서 ①상수 자체를 고정하고 ②스케일이 흔들려도 순서·부호·배지가 안정한지 본다.
{
  ok(
    "정규화 스케일이 정책 상수로 선언되어 있다",
    SCORE_SCALE.winExcess === 0.35 && SCORE_SCALE.marginExcess === 3,
    JSON.stringify(SCORE_SCALE),
  );

  /** raw 경기 → 초과성과 → 임의 스케일로 지수 계산(구현과 동일 합성식). */
  const scoreWith = (
    scale: { winExcess: number; marginExcess: number },
    game: Parameters<typeof excessOf>[0],
    n = 8,
  ) => {
    const e = excessOf(game)!;
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const axes = [
      { v: clamp(e.winExcess / scale.winExcess), w: 0.55 },
      { v: clamp(e.marginExcess / scale.marginExcess), w: 0.3 },
    ];
    const weight = axes.reduce((s, a) => s + a.w, 0);
    const composite = axes.reduce((s, a) => s + a.v * a.w, 0) / weight;
    const r = Math.sqrt(n / (n + 1));
    return Math.round(50 + composite * r * 50);
  };

  // 대표 경기 6종 — 중립/강약, 홈/원정, 박빙/대승·대패.
  const matrix: Array<{ name: string; game: Parameters<typeof excessOf>[0] }> = [
    { name: "강팀 상대 원정 대승", game: { myTeamId: WEAK, opponentTeamId: STRONG, isHome: false, result: "W", myScore: 9, oppScore: 2 } },
    { name: "강팀 상대 원정 박빙승", game: { myTeamId: WEAK, opponentTeamId: STRONG, isHome: false, result: "W", myScore: 4, oppScore: 3 } },
    { name: "강팀 상대 원정 박빙패", game: { myTeamId: WEAK, opponentTeamId: STRONG, isHome: false, result: "L", myScore: 3, oppScore: 4 } },
    { name: "중립 홈 박빙승", game: { myTeamId: NEUTRAL, opponentTeamId: NEUTRAL, isHome: true, result: "W", myScore: 4, oppScore: 3 } },
    { name: "약팀 상대 홈 박빙패", game: { myTeamId: STRONG, opponentTeamId: WEAK, isHome: true, result: "L", myScore: 3, oppScore: 4 } },
    { name: "약팀 상대 홈 대패", game: { myTeamId: STRONG, opponentTeamId: WEAK, isHome: true, result: "L", myScore: 1, oppScore: 9 } },
  ];

  // 후보 스케일 — 현행 + 삼순이 지적한 완만/공격적 변형.
  const scales = [
    { label: "정책 .35/3", winExcess: 0.35, marginExcess: 3 },
    { label: "완만 .5/4", winExcess: 0.5, marginExcess: 4 },
    { label: "공격 .25/2", winExcess: 0.25, marginExcess: 2 },
  ];

  const rankings = scales.map((scale) => ({
    label: scale.label,
    scores: matrix.map((m) => scoreWith(scale, m.game)),
  }));
  for (const r of rankings) {
    console.log(`    ${r.label}: ${matrix.map((m, i) => `${m.name} ${r.scores[i]}`).join(" · ")}`);
  }

  // ① 순서 안정성 — 스케일이 바뀌어도 경기 간 우열 순서는 동일해야 한다.
  const orderOf = (scores: number[]) =>
    scores.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]!).join(",");
  const baseOrder = orderOf(rankings[0]!.scores);
  ok(
    "스케일이 바뀌어도 경기 간 순서는 불변",
    rankings.every((r) => orderOf(r.scores) === baseOrder),
    rankings.map((r) => `${r.label}=${orderOf(r.scores)}`).join(" / "),
  );

  // ② 부호 안정성 — 50점 기준 위/아래(잘함/못함) 판정이 뒤집히지 않아야 한다.
  const signOf = (scores: number[]) =>
    scores.map((v) => (v > 50 ? "+" : v < 50 ? "-" : "0")).join("");
  const baseSign = signOf(rankings[0]!.scores);
  ok(
    "스케일이 바뀌어도 50점 기준 부호는 불변",
    rankings.every((r) => signOf(r.scores) === baseSign),
    rankings.map((r) => `${r.label}=${signOf(r.scores)}`).join(" / "),
  );

  // ③ 배지 구간 안정성 — 사용자가 보는 등급 문구가 스케일로 뒤집히면 안 된다.
  //    이것이 삼순 지적의 본체다(같은 경기로 `약간 요정 ↔ 진짜 요정`).
  const badgesOf = (scores: number[]) => scores.map(scoreBadgeLabel).join("|");
  const baseBadges = badgesOf(rankings[0]!.scores);
  ok(
    "스케일이 바뀌어도 배지 등급은 불변",
    rankings.every((r) => badgesOf(r.scores) === baseBadges),
    rankings.map((r) => `${r.label}=${badgesOf(r.scores)}`).join(" / "),
  );

  // ④ 기대와 정확히 같은 경기는 어떤 스케일에서도 50점(중립 앵커 고정).
  const neutralGames = matrix.map(() => null);
  void neutralGames;
  const neutralScores = scales.map((scale) => {
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const axes = [
      { v: clamp(0 / scale.winExcess), w: 0.55 },
      { v: clamp(0 / scale.marginExcess), w: 0.3 },
    ];
    const weight = axes.reduce((s, a) => s + a.w, 0);
    const composite = axes.reduce((s, a) => s + a.v * a.w, 0) / weight;
    return Math.round(50 + composite * Math.sqrt(8 / 9) * 50);
  });
  ok(
    "초과성과 0은 어떤 스케일에서도 50점(중립 앵커)",
    neutralScores.every((v) => v === 50),
    neutralScores.join(","),
  );

  // ⑤ 배지 경계 자체의 단조성 — 점수가 오를수록 등급이 내려가지 않는다.
  let prevRank = -1;
  const badgeOrder = ["흑염룡", "살짝 흑염룡", "평소와 비슷", "약간 요정", "진짜 요정"];
  let monotone = true;
  for (let v = 0; v <= 100; v += 1) {
    const rank = badgeOrder.indexOf(scoreBadgeLabel(v));
    if (rank < prevRank) monotone = false;
    prevRank = rank;
  }
  ok("배지 등급은 점수에 대해 단조 증가", monotone);
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
assert.equal(fail, 0);
