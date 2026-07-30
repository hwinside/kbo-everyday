/**
 * Naver failover 주자 타순/이름 회귀.
 *
 * 실경기 20260730OBSK0 relay seq 415의 base1/base2/base3=8/7/6을
 * raw B?_BAT_ORDER_NO까지 보존하고, boxScore 같은 타순의 마지막 entry로
 * 박지훈/조수행/안재석을 해석한다.
 */
import assert from "node:assert/strict";
import type { BatterRecord, GameDetailResponse, LineupEntry } from "../../src/lib/hooks/useGameDetail";
import type { LiveGameData } from "../../src/lib/hooks/useLiveGame";
import type { KboGame } from "../../src/lib/crawler/kbo-api";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "smoke-service-role-key";

function lineupEntry(order: number, name: string): LineupEntry {
  return { order, position: "PR", positionKr: "주", name, war: 0, avg: ".000" };
}

function batter(order: number, name: string, isSubstitute = false): BatterRecord {
  return {
    order,
    position: isSubstitute ? "주" : "선",
    positionFull: isSubstitute ? "대주자" : "선발",
    name,
    atBats: 0,
    hits: 0,
    runs: 0,
    rbi: 0,
    hr: 0,
    h2b: 0,
    h3b: 0,
    bb: 0,
    so: 0,
    sb: 0,
    avg: ".000",
    isSubstitute,
  };
}

function liveGameWith(o1: number, o2: number, o3: number): LiveGameData {
  return {
    gameId: "20260730OBSK0",
    awayName: "두산",
    homeName: "SSG",
    awayScore: 2,
    homeScore: 1,
    inning: 8,
    isTop: true,
    balls: 1,
    strikes: 2,
    outs: 1,
    runner1b: o1 > 0,
    runner2b: o2 > 0,
    runner3b: o3 > 0,
    runner1bOrder: o1,
    runner2bOrder: o2,
    runner3bOrder: o3,
    runner1bName: null,
    runner2bName: null,
    runner3bName: null,
    currentBatter: "정수빈",
    currentPitcher: "김광현",
    currentInning: "8회초",
    stadium: "문학",
    isLive: true,
    awayStarterName: null,
    homeStarterName: null,
  } as LiveGameData;
}

const detail = {
  status: "live",
  lineup: {
    away: [
      lineupEntry(6, "6번 선발"),
      lineupEntry(7, "7번 선발"),
      lineupEntry(8, "8번 선발"),
    ],
    home: [],
  },
  boxScore: {
    awayBatters: [
      batter(8, "8번 선발"),
      batter(8, "박지훈", true),
      batter(7, "7번 선발"),
      batter(7, "조수행", true),
      batter(6, "6번 선발"),
      batter(6, "안재석", true),
    ],
    homeBatters: [],
    awayPitchers: [],
    homePitchers: [],
  },
} as unknown as GameDetailResponse;

const game = {
  status: "live",
  inning: "8회초",
  awayScore: 2,
  homeScore: 1,
  awayTeamId: 6,
  homeTeamId: 9,
};

async function main() {
  const {
    fetchNaverLiveEvidence,
    naverGameToRaw,
    NAVER_UNKNOWN_RUNNER_ORDER,
  } = await import("../../src/lib/notifications/kbo-live-games");
  const { deriveGameState } = await import("../../src/lib/utils/game-derived");

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    result: {
      textRelayData: {
        currentGameState: {
          ball: "1",
          strike: "2",
          out: "1",
          base1: "8",
          base2: "7",
          base3: "6",
        },
        textRelays: [{
          textOptions: [{ seqno: 415, pitchNum: 93, ptsPitchId: "20260730OBSK0_93" }],
        }],
      },
    },
  })) as typeof fetch;

  let evidence;
  try {
    evidence = await fetchNaverLiveEvidence("20260730OBSK0", AbortSignal.timeout(1_000));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    [evidence.runner1bOrder, evidence.runner2bOrder, evidence.runner3bOrder],
    [8, 7, 6],
    "Naver relay 타순 8/7/6을 보존해야 한다",
  );

  const naverGame = {
    gameId: "20260730OBSK0",
    date: "20260730",
    time: "18:30",
    stadium: "문학",
    awayTeamId: 6,
    homeTeamId: 9,
    awayName: "두산",
    homeName: "SSG",
    awayScore: 2,
    homeScore: 1,
    inning: 8,
    isTop: true,
    status: "live",
    awayStarterName: "",
    homeStarterName: "",
    winPitcher: "",
    losePitcher: "",
    savePitcher: "",
    strikes: evidence.strikes,
    balls: evidence.balls,
    outs: evidence.outs,
    runnersOn: {
      first: evidence.runner1b,
      second: evidence.runner2b,
      third: evidence.runner3b,
    },
    runnerOrders: {
      first: evidence.runner1bOrder,
      second: evidence.runner2bOrder,
      third: evidence.runner3bOrder,
    },
    currentPitcher: "",
    currentBatter: "",
    awayRank: 0,
    homeRank: 0,
  } satisfies KboGame;
  const raw = naverGameToRaw(naverGame);
  assert.deepEqual(
    [raw.B1_BAT_ORDER_NO, raw.B2_BAT_ORDER_NO, raw.B3_BAT_ORDER_NO],
    [8, 7, 6],
    "raw B?_BAT_ORDER_NO까지 타순을 보존해야 한다",
  );

  const derived = deriveGameState(liveGameWith(8, 7, 6), game, detail);
  assert.deepEqual(
    [derived.runner1bName, derived.runner2bName, derived.runner3bName],
    ["박지훈", "조수행", "안재석"],
    "같은 타순의 마지막 boxScore entry(대타/대주자)를 현재 주자로 해석해야 한다",
  );
  assert.ok(derived.currentRunner1b && derived.currentRunner2b && derived.currentRunner3b);

  // 결함 주입: 과거처럼 실제 타순을 1로 뭉개면 세 실명이 모두 사라진다.
  const collapsed = deriveGameState(liveGameWith(1, 1, 1), game, detail);
  assert.notDeepEqual(
    [collapsed.runner1bName, collapsed.runner2bName, collapsed.runner3bName],
    ["박지훈", "조수행", "안재석"],
  );

  // 점유는 알지만 타순이 범위 밖인 경우에만 sentinel로 점등을 유지하고 이름은 fail-soft.
  const unknownRaw = naverGameToRaw({
    ...naverGame,
    runnerOrders: undefined,
    runnersOn: { first: true, second: false, third: false },
  });
  assert.equal(unknownRaw.B1_BAT_ORDER_NO, NAVER_UNKNOWN_RUNNER_ORDER);
  const unknown = deriveGameState(liveGameWith(NAVER_UNKNOWN_RUNNER_ORDER, 0, 0), game, detail);
  assert.equal(unknown.currentRunner1b, true);
  assert.equal(unknown.runner1bName, null);
  assert.equal(unknown.runner1bName || "주자", "주자");

  console.log("naver-runner-name smoke: PASS (8/7/6 → 박지훈/조수행/안재석, 교체 마지막 entry, fail-soft)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
