/**
 * QA: Naver failover 주자 이름 오표시 회귀 (P0, 2026-07-30 실사고).
 *
 * 사고: Naver failover 시 naverGameToRaw 가 베이스 점유를 *타순 1*로 합성 →
 * 소비측 resolveRunnerName(game-derived)이 1번 타자 이름을 boxScore/lineup 에서
 * 찾아 모든 점유 베이스에 표시(두산:SSG에서 두산 1번 박찬호가 1·2·3루 전부 표시).
 *
 * 고정하는 계약:
 * 1) [RED 실증] 구 코드의 order=1 합성은 실제로 1번 타자 이름을 전 베이스에 붙인다
 *    (결함 주입으로 사고 벡터 재현 — resolver 는 order 1..9 를 정상 해석해야 하므로).
 * 2) [GREEN] naverGameToRaw 는 점유 시 NAVER_UNKNOWN_RUNNER_ORDER(1..9 밖)를 내보내고,
 *    deriveGameState 결과는 점유 점등(currentRunner*=true) 유지 + 이름 null
 *    (FieldViewV2 는 `runner1bName || "주자"` 로 "주자" 표기).
 * 3) [회귀 0] KBO 정상 경로(실제 타순 1..9)는 boxScore 마지막 entry 우선 →
 *    lineup fallback 순서로 기존과 동일하게 이름을 해석한다.
 *
 * 실행: npx tsx scripts/qa/naver-runner-name-smoke.ts
 */
import type { GameDetailResponse, LineupEntry, BatterRecord } from "../../src/lib/hooks/useGameDetail";
import type { LiveGameData } from "../../src/lib/hooks/useLiveGame";
import type { KboGame } from "../../src/lib/crawler/kbo-api";

// import 체인(api-fallback-tracker → supabase admin)이 모듈 스코프에서 env 를 요구하므로
// 앱 코드는 env 설정 후 동적 import 한다(kbo-live-games-failover smoke 와 동일 패턴).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "smoke-service-role-key";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}

function lineupEntry(order: number, position: string, name: string): LineupEntry {
  return { order, position, positionKr: position, name, war: 0, avg: ".300" };
}
function batter(order: number, position: string, name: string, isSubstitute = false): BatterRecord {
  return {
    order, position, positionFull: position, name,
    atBats: 0, hits: 0, runs: 0, rbi: 0, hr: 0, h2b: 0, h3b: 0, bb: 0, so: 0, sb: 0,
    avg: ".000", isSubstitute,
  };
}

// 원정(두산) 라인업 — 사고 당시 1번 박찬호.
const awayLineup: LineupEntry[] = [
  lineupEntry(1, "SS", "박찬호"),
  lineupEntry(2, "CF", "정수빈"),
  lineupEntry(3, "C", "양의지"),
  lineupEntry(4, "1B", "양석환"),
];
const detail = {
  status: "live",
  lineup: { away: awayLineup, home: [] },
  boxScore: {
    awayBatters: [batter(1, "SS", "박찬호"), batter(2, "CF", "정수빈"), batter(4, "1B", "양석환")],
    homeBatters: [], awayPitchers: [], homePitchers: [],
  },
} as unknown as GameDetailResponse;

const game = { status: "live", inning: "5회초", awayScore: 1, homeScore: 2, awayTeamId: 6, homeTeamId: 9 };

function liveGameWith(orders: { o1?: number; o2?: number; o3?: number }): LiveGameData {
  return {
    gameId: "20260730OBSK0", awayName: "두산", homeName: "SSG",
    awayScore: 1, homeScore: 2, inning: 5, isTop: true,
    balls: 0, strikes: 0, outs: 1,
    runner1b: (orders.o1 ?? 0) > 0,
    runner2b: (orders.o2 ?? 0) > 0,
    runner3b: (orders.o3 ?? 0) > 0,
    runner1bOrder: orders.o1 ?? 0,
    runner2bOrder: orders.o2 ?? 0,
    runner3bOrder: orders.o3 ?? 0,
    runner1bName: null, runner2bName: null, runner3bName: null,
    currentBatter: "양의지", currentPitcher: "김광현",
    currentInning: "5회초", stadium: "잠실", isLive: true,
    awayStarterName: null, homeStarterName: null,
  } as LiveGameData;
}

async function main() {
const { deriveGameState } = await import("../../src/lib/utils/game-derived");
const { naverGameToRaw, NAVER_UNKNOWN_RUNNER_ORDER } = await import("../../src/lib/notifications/kbo-live-games");

console.log("1) [RED 실증] 구 코드 order=1 합성 → 1번 타자가 전 베이스에 표시되는 사고 벡터");
{
  const d = deriveGameState(liveGameWith({ o1: 1, o2: 1, o3: 1 }), game, detail);
  check("order=1 합성이면 1루 이름 = 박찬호(사고 재현)", d.runner1bName === "박찬호", `got ${d.runner1bName}`);
  check("order=1 합성이면 2루 이름 = 박찬호(사고 재현)", d.runner2bName === "박찬호", `got ${d.runner2bName}`);
  check("order=1 합성이면 3루 이름 = 박찬호(사고 재현)", d.runner3bName === "박찬호", `got ${d.runner3bName}`);
}

console.log("2) [GREEN] naverGameToRaw sentinel → 점등 유지 + 이름 해석 skip(null → UI '주자')");
{
  const naverGame = {
    gameId: "20260730OBSK0", date: "20260730", time: "18:30", stadium: "잠실",
    awayTeamId: 6, homeTeamId: 9, awayName: "두산", homeName: "SSG",
    awayScore: 1, homeScore: 2, inning: 5, isTop: true, status: "live",
    awayStarterName: "", homeStarterName: "", winPitcher: "", losePitcher: "", savePitcher: "",
    strikes: 0, balls: 0, outs: 1,
    runnersOn: { first: true, second: true, third: true },
    currentPitcher: "김광현", currentBatter: "양의지", awayRank: 0, homeRank: 0,
  } as KboGame;
  const raw = naverGameToRaw(naverGame);
  check("점유 베이스 order = sentinel(>0, 1..9 밖)",
    raw.B1_BAT_ORDER_NO === NAVER_UNKNOWN_RUNNER_ORDER
    && raw.B2_BAT_ORDER_NO === NAVER_UNKNOWN_RUNNER_ORDER
    && raw.B3_BAT_ORDER_NO === NAVER_UNKNOWN_RUNNER_ORDER
    && NAVER_UNKNOWN_RUNNER_ORDER > 9,
    `got ${raw.B1_BAT_ORDER_NO}/${raw.B2_BAT_ORDER_NO}/${raw.B3_BAT_ORDER_NO}`);
  check("무점유 베이스 order = 0",
    naverGameToRaw({ ...naverGame, runnersOn: { first: false, second: false, third: false } }).B1_BAT_ORDER_NO === 0);

  // game-live route 매핑 그대로: runner?b = order>0, runner?bOrder = order.
  const d = deriveGameState(liveGameWith({
    o1: raw.B1_BAT_ORDER_NO, o2: raw.B2_BAT_ORDER_NO, o3: raw.B3_BAT_ORDER_NO,
  }), game, detail);
  check("점유 점등 유지(1·2·3루)", d.currentRunner1b && d.currentRunner2b && d.currentRunner3b);
  check("1루 이름 = null(특정 선수명 아님)", d.runner1bName === null, `got ${d.runner1bName}`);
  check("2루 이름 = null(특정 선수명 아님)", d.runner2bName === null, `got ${d.runner2bName}`);
  check("3루 이름 = null(특정 선수명 아님)", d.runner3bName === null, `got ${d.runner3bName}`);
  // FieldViewV2 계약: name={runner1bName || "주자"} → null이면 "주자" 표기.
  check("UI 표기 = '주자'(FieldViewV2 fallback)", (d.runner1bName || "주자") === "주자");
}

console.log("3) [회귀 0] KBO 정상 경로 — 실제 타순 해석 기존 동작 유지");
{
  const d = deriveGameState(liveGameWith({ o1: 2, o2: 4, o3: 3 }), game, detail);
  check("1루 order=2 → boxScore에서 정수빈", d.runner1bName === "정수빈", `got ${d.runner1bName}`);
  check("2루 order=4 → boxScore에서 양석환", d.runner2bName === "양석환", `got ${d.runner2bName}`);
  check("3루 order=3 → boxScore 미기재 시 lineup fallback 양의지", d.runner3bName === "양의지", `got ${d.runner3bName}`);
  // 대타 교체: 같은 order 마지막 entry 우선(기존 계약).
  const subDetail = {
    ...detail,
    boxScore: {
      awayBatters: [batter(2, "CF", "정수빈"), batter(2, "타", "제라드", true)],
      homeBatters: [], awayPitchers: [], homePitchers: [],
    },
  } as unknown as GameDetailResponse;
  const d2 = deriveGameState(liveGameWith({ o1: 2 }), game, subDetail);
  check("교체 후 같은 order 마지막 entry = 제라드", d2.runner1bName === "제라드", `got ${d2.runner1bName}`);
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
