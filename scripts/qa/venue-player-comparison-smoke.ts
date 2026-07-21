import assert from "node:assert/strict";
import type { KboGame } from "../../src/lib/crawler/kbo-api";
import {
  buildFavoritePlayerPerformances,
  type PlayerGameLog,
} from "../../src/lib/venue-attendance/player-comparison";

const fixtureGame: KboGame = {
  gameId: "20260721LGLT0",
  date: "20260721",
  time: "18:30",
  stadium: "잠실",
  awayTeamId: 1,
  homeTeamId: 7,
  awayName: "LG",
  homeName: "롯데",
  awayScore: 5,
  homeScore: 3,
  inning: 9,
  isTop: false,
  status: "final",
  awayStarterName: "",
  homeStarterName: "",
  winPitcher: "",
  losePitcher: "",
  savePitcher: "",
  strikes: 0,
  balls: 0,
  outs: 0,
  runnersOn: { first: false, second: false, third: false },
  currentPitcher: "",
  currentBatter: "",
  awayRank: 0,
  homeRank: 0,
};

function batterLog(overrides: Partial<PlayerGameLog>): PlayerGameLog {
  return {
    kbo_id: "50108",
    player_type: "batter",
    game_id: "20260720LGOB0",
    game_date: "2026-07-20",
    team_id: 1,
    ab: 4,
    h: 1,
    hr: 0,
    rbi: 0,
    bb: 0,
    so: 0,
    ip_outs: 0,
    er: 0,
    h_allowed: 0,
    k: 0,
    bb_allowed: 0,
    ...overrides,
  };
}

const favorites = [
  { playerId: "50108", name: "김타자", teamId: 1, position: "외야수" },
  { playerId: "60123", name: "박투수", teamId: 7, position: "투수" },
  { playerId: "70111", name: "이중립", teamId: 9, position: "내야수" },
];

const logs: PlayerGameLog[] = [
  batterLog({ game_id: "20260718LGOB0", game_date: "2026-07-18" }),
  batterLog({ game_id: "20260719LGOB0", game_date: "2026-07-19" }),
  batterLog({ game_id: "20260720LGOB0", game_date: "2026-07-20" }),
  batterLog({ game_id: fixtureGame.gameId, game_date: "2026-07-21", h: 2, hr: 1, rbi: 2 }),
  // 미래 경기의 큰 기록은 7/21 이전 평균에 절대 섞이면 안 된다.
  batterLog({ game_id: "20260722LGOB0", game_date: "2026-07-22", h: 4, hr: 4, rbi: 10 }),
  ...["2026-07-18", "2026-07-19", "2026-07-20"].map((gameDate, index) => ({
    ...batterLog({}),
    kbo_id: "60123",
    player_type: "pitcher" as const,
    game_id: `pitcher-prior-${index}`,
    game_date: gameDate,
    team_id: 7,
    ab: 0,
    h: 0,
    ip_outs: 9,
    er: 2,
    k: 2,
  })),
  {
    ...batterLog({}),
    kbo_id: "60123",
    player_type: "pitcher",
    game_id: fixtureGame.gameId,
    game_date: "2026-07-21",
    team_id: 7,
    ab: 0,
    h: 0,
    ip_outs: 18,
    er: 1,
    k: 7,
  },
];

const result = buildFavoritePlayerPerformances({
  favorites,
  logs,
  game: fixtureGame,
  gameLogReady: true,
});
assert.equal(result.length, 2, "참가팀 최애선수만 표시");
assert.equal(result[0].state, "rated", "이전 3경기부터 평가");
assert.equal(result[0].lines[0].evaluation, "above", "안타·홈런·타점 활약이 경기 전 평균보다 높음");
assert.equal(result[0].lines[0].average?.ab, 4, "타자 경기 전 평균 타수");
assert.equal(result[0].lines[0].average?.h, 1, "현재·미래 경기 제외 경기당 평균 안타");
assert.equal(result[1].lines[0].evaluation, "above", "이닝·자책·삼진 활약이 경기 전 평균보다 높음");
assert.equal(result[1].lines[0].average?.innings, 3, "투수 경기 전 평균 이닝");
assert.equal(result[1].lines[0].average?.er, 2, "투수 경기 전 평균 자책");

const limited = buildFavoritePlayerPerformances({
  favorites: favorites.slice(0, 1),
  logs: logs.filter((log) => log.game_date >= "2026-07-19" && log.game_date <= "2026-07-21"),
  game: fixtureGame,
  gameLogReady: true,
});
assert.equal(limited[0].state, "sample_limited", "이전 2경기는 표본 부족");
assert.equal(limited[0].lines[0].evaluation, null, "표본 부족 시 과장 평가 금지");

const withoutCurrent = logs.filter((log) => log.game_id !== fixtureGame.gameId);
assert.equal(
  buildFavoritePlayerPerformances({ favorites: favorites.slice(0, 1), logs: withoutCurrent, game: fixtureGame, gameLogReady: true })[0].state,
  "not_played",
  "적재 완료 후 행 없음은 미출전",
);
assert.equal(
  buildFavoritePlayerPerformances({ favorites: favorites.slice(0, 1), logs: withoutCurrent, game: fixtureGame, gameLogReady: false })[0].state,
  "pending",
  "적재 전은 기록 집계 중",
);

console.log("venue player comparison smoke: PASS (9 assertions)");
