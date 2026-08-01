import type { SeasonGameVerification } from "@/lib/venue-stats/aggregate";

/**
 * 직관 경기의 **경기 시작 전(pregame) 기대 퍼포먼스**.
 *
 * 하린아빠 2026-08-02: "관전가치 기준이 아니라 무조건 팀퍼포먼스와의 상관도를 봐야지".
 * 삼순 2026-08-02: 승패/득실 초과성과는 반드시 *해당 경기 시작 전 데이터*로 계산할 것 —
 * 대상 경기나 이후 경기가 섞인 시즌 누적값은 leakage 다.
 *
 * 그래서 기대치는 `gameDate < 대상 경기일` 인 정규시즌 final 만으로 계산한다.
 * 같은 날 경기(더블헤더 포함)도 제외 — 대상 경기 자신이 섞이는 것을 원천 차단.
 */

/** 한 팀의 pregame 누적 성적. */
interface PriorRecord {
  games: number;
  wins: number;
  draws: number;
  runsScored: number;
  runsAllowed: number;
}

/**
 * 기대치를 신뢰하려면 양 팀 모두 이만큼의 pregame 경기가 필요하다.
 * 개막 직후 표본으로 기대승률을 만들면 그 자체가 잡음이라, 미달이면 그 경기는
 * 기대치 없음으로 두고 **지수 전체를 fail-close** 한다(축 재정규화로 덮지 않는다 — 삼순 P0).
 */
export const MIN_PRIOR_GAMES = 5;

/**
 * 홈 어드밴티지 보정.
 *
 * ⚠️ 삼순 P0 (2026-08-02): 이전 값(승률 ±.02 / 마진 ±.15)은 **출처 없는 손튜닝**이었다.
 *
 * 실측(2026 `player_game_logs` 홈팀 기준 고유 final 493경기):
 *   홈 승률(무=0.5) = .5051 → edge **+0.0051**, 95%CI [-0.0391, +0.0492]
 *   → 신뢰구간이 0을 포함한다. 즉 **현재 데이터로는 홈 어드밴티지가 유의하지 않다.**
 *
 * 그래서 발명한 +.02 대신 측정된 점추정치를 쓰고, 상수가 실측 CI 안에 있는지를
 * 회귀(`qa:venue-stats-expected`)로 고정한다. 시즌이 쌓이면 재측정 대상이다.
 *
 * 마진 보정은 직접 실측하지 못했다(KBO 일정 API 500, 우리 DB에 팀 득점 원장 없음).
 * 승률 edge 와 같은 크기의 "거의 0" 정책값으로 두고, 아래 SENSITIVITY 계약으로
 * 이 값이 지수 부호를 뒤집지 못하게 묶는다 — 근거 없는 큰 보정을 원천 차단.
 */
export const HOME_WIN_EDGE = 0.005;
export const HOME_MARGIN_EDGE = 0.05;

/** 실측 홈 승률 edge 95% CI — 상수가 이 범위를 벗어나면 회귀가 FAIL. */
export const MEASURED_HOME_WIN_EDGE_CI = { low: -0.0391, high: 0.0492 } as const;

/**
 * 기대 마진 상한 — 극단 팀 조합에서 기대치가 발산하지 않게 자른다.
 * 데이터 튜닝이 아니라 **제품 정책 상수**다(삼순 허용 경로). KBO 경기당 팀 득점이
 * 대략 4~5점대인 점을 감안해 "한 팀이 상대를 평균 4점 차로 압도" 를 사실상 상한으로 본다.
 */
export const MAX_EXPECTED_MARGIN = 4;

export interface PregameExpectation {
  /** log5 + 홈 보정 기대 승률(0~1). */
  expectedWinProb: number;
  /** 기대 득실 마진(내 팀 기준, 점). */
  expectedMargin: number;
}

export interface GameExcess {
  gameId: string;
  /** 실제 승점(승 1 · 무 0.5 · 패 0) − 기대 승률. -1~1. */
  winExcess: number;
  /** 실제 마진 − 기대 마진(점). */
  marginExcess: number;
}

function emptyRecord(): PriorRecord {
  return { games: 0, wins: 0, draws: 0, runsScored: 0, runsAllowed: 0 };
}

/**
 * `gameDate` 이전(미포함) 정규시즌 final 로 팀별 누적 성적을 만든다.
 * 공식 스코어(awayTeamId/homeTeamId/awayScore/homeScore)가 없는 경기는 애초에
 * B3 계약에서 전량 fail-close 되므로 여기서는 스코어가 있는 경기만 신뢰한다.
 */
function priorRecords(
  seasonGames: readonly SeasonGameVerification[],
  beforeDate: string,
): Map<number, PriorRecord> {
  const records = new Map<number, PriorRecord>();
  const touch = (teamId: number): PriorRecord => {
    let record = records.get(teamId);
    if (!record) {
      record = emptyRecord();
      records.set(teamId, record);
    }
    return record;
  };
  for (const game of seasonGames) {
    // leakage 차단 — 대상 경기일 당일/이후는 통째로 제외.
    if (!(game.gameDate < beforeDate)) continue;
    const { awayTeamId, homeTeamId, awayScore, homeScore } = game;
    if (
      awayTeamId === undefined || homeTeamId === undefined ||
      awayScore === undefined || homeScore === undefined
    ) continue;
    const away = touch(awayTeamId);
    const home = touch(homeTeamId);
    away.games += 1;
    home.games += 1;
    away.runsScored += awayScore;
    away.runsAllowed += homeScore;
    home.runsScored += homeScore;
    home.runsAllowed += awayScore;
    if (awayScore > homeScore) away.wins += 1;
    else if (homeScore > awayScore) home.wins += 1;
    else {
      away.draws += 1;
      home.draws += 1;
    }
  }
  return records;
}

/** 무승부를 0.5승으로 본 승률. */
function winPct(record: PriorRecord): number {
  return (record.wins + record.draws * 0.5) / record.games;
}

/**
 * log5 — 두 팀 승률로 맞대결 기대 승률을 낸다(Bill James).
 * 양 팀이 모두 5할이면 0.5, 한쪽이 압도적이면 그 쪽으로 수렴한다.
 */
function log5(mine: number, theirs: number): number {
  const denominator = mine + theirs - 2 * mine * theirs;
  if (denominator <= 0) return 0.5;
  return (mine - mine * theirs) / denominator;
}

/**
 * 한 경기의 pregame 기대치. 양 팀 중 하나라도 `MIN_PRIOR_GAMES` 미만이면 null.
 */
export function pregameExpectation(
  seasonGames: readonly SeasonGameVerification[],
  params: { gameDate: string; myTeamId: number; opponentTeamId: number; isHome: boolean },
): PregameExpectation | null {
  const records = priorRecords(seasonGames, params.gameDate);
  const mine = records.get(params.myTeamId);
  const theirs = records.get(params.opponentTeamId);
  if (!mine || !theirs) return null;
  if (mine.games < MIN_PRIOR_GAMES || theirs.games < MIN_PRIOR_GAMES) return null;

  const base = log5(winPct(mine), winPct(theirs));
  const expectedWinProb = Math.min(
    0.95,
    Math.max(0.05, base + (params.isHome ? HOME_WIN_EDGE : -HOME_WIN_EDGE)),
  );

  const myDiff = (mine.runsScored - mine.runsAllowed) / mine.games;
  const theirDiff = (theirs.runsScored - theirs.runsAllowed) / theirs.games;
  const rawMargin = myDiff - theirDiff + (params.isHome ? HOME_MARGIN_EDGE : -HOME_MARGIN_EDGE);
  const expectedMargin = Math.min(MAX_EXPECTED_MARGIN, Math.max(-MAX_EXPECTED_MARGIN, rawMargin));

  return { expectedWinProb, expectedMargin };
}

/**
 * 직관 경기 목록의 초과성과.
 *
 * 반환 null = 한 경기라도 pregame 기대치를 못 만든 경우(삼순 P0 fail-close).
 * "1점패는 5점패보다 높되 자동 플러스가 아니다" — 강팀 상대 기대 −3인데 −1이면 플러스,
 * 약팀 상대 기대 +2인데 −1이면 마이너스. 부호는 전적으로 기대 대비로 정해진다.
 */
export function computeExcessPerformance(
  seasonGames: readonly SeasonGameVerification[],
  attended: ReadonlyArray<{
    gameId: string;
    gameDate: string;
    myTeamId: number | null;
    opponentTeamId: number | null;
    isHome: boolean | null;
    result: "W" | "L" | "D" | null;
    myScore: number | null;
    oppScore: number | null;
  }>,
): GameExcess[] | null {
  if (attended.length === 0) return null;
  const excesses: GameExcess[] = [];
  for (const game of attended) {
    if (
      game.myTeamId == null || game.opponentTeamId == null || game.isHome == null ||
      game.result == null || game.myScore == null || game.oppScore == null
    ) return null;
    const expectation = pregameExpectation(seasonGames, {
      gameDate: game.gameDate,
      myTeamId: game.myTeamId,
      opponentTeamId: game.opponentTeamId,
      isHome: game.isHome,
    });
    if (expectation === null) return null;
    const actualWinPoints = game.result === "W" ? 1 : game.result === "D" ? 0.5 : 0;
    excesses.push({
      gameId: game.gameId,
      winExcess: actualWinPoints - expectation.expectedWinProb,
      marginExcess: (game.myScore - game.oppScore) - expectation.expectedMargin,
    });
  }
  return excesses;
}
