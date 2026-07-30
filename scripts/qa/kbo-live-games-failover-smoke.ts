import assert from "node:assert/strict";
import { fetchKboLiveGames } from "../../src/lib/notifications/kbo-live-games";
import type { KboGame } from "../../src/lib/crawler/kbo-api";

const naverGames: KboGame[] = [{
  gameId: "20260730WOLG0",
  date: "20260730",
  time: "18:30",
  stadium: "잠실",
  awayTeamId: 10,
  homeTeamId: 3,
  awayName: "키움",
  homeName: "LG",
  awayScore: 0,
  homeScore: 0,
  inning: 1,
  isTop: true,
  status: "live",
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
}];

async function main() {
  let naverCalls = 0;
  const failedKbo = async () => new Response(null, { status: 503 });
  const naver = async () => {
    naverCalls += 1;
    return naverGames;
  };

  const fallback = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    failedKbo as typeof fetch,
    naver,
  );
  assert.equal(fallback.ok, true);
  assert.equal(fallback.trace.source, "naver");
  assert.equal(naverCalls, 1);
  assert.deepEqual(fallback.games[0], {
    G_ID: "20260730WOLG0",
    G_DT: "20260730",
    G_TM: "18:30",
    S_NM: "잠실",
    AWAY_ID: "WO",
    HOME_ID: "LG",
    AWAY_NM: "키움",
    HOME_NM: "LG",
    T_SCORE_CN: "0",
    B_SCORE_CN: "0",
    GAME_INN_NO: 1,
    GAME_TB_SC: "T",
    GAME_STATE_SC: "2",
    CANCEL_SC_ID: "0",
    T_PIT_P_NM: "",
    B_PIT_P_NM: "",
    W_PIT_P_NM: "",
    L_PIT_P_NM: "",
    SV_PIT_P_NM: "",
    STRIKE_CN: 0,
    BALL_CN: 0,
    OUT_CN: 0,
    B1_BAT_ORDER_NO: 0,
    B2_BAT_ORDER_NO: 0,
    B3_BAT_ORDER_NO: 0,
    B_P_NM: "",
    T_P_NM: "",
    T_RANK_NO: 0,
    B_RANK_NO: 0,
  });

  const kbo = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    (async () => new Response(JSON.stringify({
      game: [{
        G_ID: "20260730HTSS0",
        GAME_STATE_SC: "1",
        AWAY_NM: "KIA",
        HOME_NM: "삼성",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    naver,
  );
  assert.equal(kbo.ok, true);
  assert.equal(kbo.trace.source, "kbo");
  assert.equal(naverCalls, 1);

  const bothFailed = await fetchKboLiveGames(
    "20260730",
    Date.now() + 2_000,
    failedKbo as typeof fetch,
    async () => { throw new Error("naver down"); },
  );
  assert.equal(bothFailed.ok, false);
  assert.deepEqual(bothFailed.games, []);

  console.log("kbo-live-games-failover: 3/3 PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
