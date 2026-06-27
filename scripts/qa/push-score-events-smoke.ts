/**
 * Regression smoke — push-notifications S5a 득점 이벤트 (삼순 PR #213 NO-GO 2건).
 *
 * ① 멀티런 홈런 중복 방지: 2/3/만루 홈런이면 점수 증가 전체가 홈런으로 설명되므로
 *    event-generator가 run_scored를 suppress해야 한다. 안 그러면 같은 득점 상황에서
 *    at_bat_homerun + run_scored 둘 다 떠 같은 팀 팬에게 2푸시가 간다.
 * ② 득점팀 분리: run_scored는 detail.scoringSide로 팀을 확정해야 하고(알림 레이어가
 *    isTop 추론 안 하게), 양팀이 같은 polling에 득점하면 팀별로 분리 발화해야 한다.
 *
 * 실행: npm run qa:push-score-events
 */
import { generateEvents, type PrevGameState } from "@/lib/event-generator";
import { isHomerunCoveredRun, resolveHomerunScore, resolvePhantomSingle, inheritHitRbi, PHANTOM_SINGLE_WAIT_MS } from "@/lib/notifications/score-dedupe";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import type { BatterRecord, GameDetailResponse } from "@/app/api/game-detail/route";
import type { GameEvent } from "@/types/game-events";

const GAME_ID = "20260611TEST0";

function mkLive(o: Partial<LiveGameData> = {}): LiveGameData {
  return {
    gameId: GAME_ID,
    isLive: true,
    inning: 5,
    isTop: false,
    balls: 0,
    strikes: 0,
    outs: 0,
    awayScore: 0,
    homeScore: 0,
    awayTeam: "A",
    homeTeam: "H",
    awayTeamFull: "Away",
    homeTeamFull: "Home",
    runner1b: false,
    runner2b: false,
    runner3b: false,
    runner1bName: null,
    runner2bName: null,
    runner3bName: null,
    currentBatter: "타자A",
    currentPitcher: "투수A",
    stadium: "",
    startTime: "",
    statusCode: 4,
    statusInfo: "",
    inningHalfDisplay: "5말",
    ...o,
  } as LiveGameData;
}

function mkBatter(o: Partial<BatterRecord> & { name: string }): BatterRecord {
  return {
    order: 4, position: "지", positionFull: "지명",
    atBats: 0, hits: 0, rbi: 0, runs: 0, hr: 0, h2b: 0, h3b: 0,
    bb: 0, so: 0, sb: 0, avg: ".000", isSubstitute: false,
    ...o,
  } as BatterRecord;
}

function mkBox(away: BatterRecord[], home: BatterRecord[]): GameDetailResponse["boxScore"] {
  return { awayBatters: away, homeBatters: home, awayPitchers: [], homePitchers: [] } as unknown as GameDetailResponse["boxScore"];
}

let failed = 0;
function assert(label: string, cond: boolean, detail?: unknown) {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}`);
  if (!cond) { failed++; if (detail !== undefined) console.log("  detail:", detail); }
}
function ofType(events: GameEvent[], type: string): GameEvent[] {
  return events.filter(e => e.type === type);
}

/** home 공격(isTop=false)에서 home 타자가 홈런 1개 + homeScore가 runs만큼 증가 */
function homeHomerun(runs: number): GameEvent[] {
  const prev: PrevGameState = {
    live: mkLive({ homeScore: 0, isTop: false }),
    boxScore: mkBox([], [mkBatter({ name: "타자A", hr: 0, hits: 0 })]),
  };
  const curr = mkLive({ homeScore: runs, isTop: false });
  const box = mkBox([], [mkBatter({ name: "타자A", hr: 1, hits: 1 })]);
  return generateEvents(GAME_ID, prev, curr, box).events;
}

// ── ① 멀티런 홈런: run_scored suppress ────────────────────────────────
for (const runs of [2, 3, 4]) {
  const ev = homeHomerun(runs);
  const hr = ofType(ev, "at_bat_homerun");
  const rs = ofType(ev, "run_scored");
  assert(`${runs}점 홈런: at_bat_homerun 정확히 1개`, hr.length === 1, ev.map(e => e.id));
  assert(`${runs}점 홈런: run_scored suppress(0개)`, rs.length === 0, rs.map(e => e.id));
}

// ── ② 득점팀 분리 & scoringSide ───────────────────────────────────────
// 일반 적시타(home, 홈런 없음): run_scored 1개 + scoringSide=home
{
  const prev: PrevGameState = {
    live: mkLive({ homeScore: 0, isTop: false }),
    boxScore: mkBox([], [mkBatter({ name: "타자B", hits: 0 })]),
  };
  const curr = mkLive({ homeScore: 1, isTop: false });
  const box = mkBox([], [mkBatter({ name: "타자B", hits: 1 })]);
  const ev = generateEvents(GAME_ID, prev, curr, box).events;
  const rs = ofType(ev, "run_scored");
  assert("적시타(home): run_scored 1개", rs.length === 1, ev.map(e => e.id));
  assert("적시타(home): scoringSide=home", rs[0]?.detail?.scoringSide === "home", rs[0]?.detail);
}

// away 적시타(isTop=true): scoringSide=away
{
  const prev: PrevGameState = {
    live: mkLive({ awayScore: 0, isTop: true }),
    boxScore: mkBox([mkBatter({ name: "타자C", hits: 0 })], []),
  };
  const curr = mkLive({ awayScore: 1, isTop: true });
  const box = mkBox([mkBatter({ name: "타자C", hits: 1 })], []);
  const ev = generateEvents(GAME_ID, prev, curr, box).events;
  const rs = ofType(ev, "run_scored");
  assert("적시타(away): scoringSide=away", rs.length === 1 && rs[0]?.detail?.scoringSide === "away", rs.map(e => e.detail));
}

// 양팀 동시 득점(홈런 없음): 팀별 run_scored 2개 + 서로 다른 scoringSide·id
{
  const prev: PrevGameState = {
    live: mkLive({ awayScore: 0, homeScore: 0, isTop: false }),
    boxScore: mkBox([], []),
  };
  const curr = mkLive({ awayScore: 1, homeScore: 1, isTop: false });
  const box = mkBox([], []);
  const ev = generateEvents(GAME_ID, prev, curr, box).events;
  const rs = ofType(ev, "run_scored");
  const sides = rs.map(e => e.detail?.scoringSide).sort();
  assert("양팀 동시 득점: run_scored 2개", rs.length === 2, rs.map(e => e.id));
  assert("양팀 동시 득점: scoringSide away+home", JSON.stringify(sides) === JSON.stringify(["away", "home"]), sides);
  assert("양팀 동시 득점: id 충돌 없음(side 포함)", new Set(rs.map(e => e.id)).size === 2, rs.map(e => e.id));
}

// ── ③ 교차-폴링 홈런 중복 방지 (game-score isHomerunCoveredRun) ──────────
// 홈런은 BoxScore에서 먼저 감지되고 그 득점은 다음 폴링에 라이브 스코어로 반영되므로,
// generator의 같은-사이클 suppression이 시차로 놓친다 → 알림 레이어가 누적 이벤트로 막는다.
function mkGE(o: Partial<GameEvent> & { type: GameEvent["type"]; inning: number; isTop: boolean; timestamp: string }): GameEvent {
  return {
    id: `${GAME_ID}-${o.type}-${o.inning}-${o.isTop ? "T" : "B"}`,
    gameId: GAME_ID, detail: {}, text: "", snapshot: {} as GameEvent["snapshot"], ...o,
  } as GameEvent;
}
{
  const T = "2026-06-24T10:44:03.000Z";
  const hr = mkGE({ type: "at_bat_homerun", inning: 4, isTop: false, timestamp: "2026-06-24T10:43:48.000Z", detail: { batter: "오스틴" } });
  const run = mkGE({ type: "run_scored", inning: 4, isTop: false, timestamp: T, detail: { scoringSide: "home", rbi: 1 } });
  // 1) 실제 버그 케이스: HR 15초 뒤 run_scored → suppress
  assert("교차폴링 홈런 득점: 중복 억제(true)", isHomerunCoveredRun(run, [hr, run]) === true);
  // 2) 홈런 없는 일반 적시타 → 억제 안 함
  assert("적시타 단독: 억제 안 함(false)", isHomerunCoveredRun(run, [run]) === false);
  // 3) 같은 이닝이지만 20분 뒤 후속 안타 득점(시간창 밖) → 억제 안 함(큰 이닝 보호)
  const lateRun = mkGE({ type: "run_scored", inning: 4, isTop: false, timestamp: "2026-06-24T11:04:03.000Z", detail: { scoringSide: "home", rbi: 1 } });
  assert("큰 이닝 후속 득점(시간창 밖): 억제 안 함(false)", isHomerunCoveredRun(lateRun, [hr, lateRun]) === false);
  // 4) 반대 half의 홈런과는 매칭 안 됨
  const awayRun = mkGE({ type: "run_scored", inning: 4, isTop: true, timestamp: T, detail: { scoringSide: "away", rbi: 1 } });
  assert("반대 half 홈런: 억제 안 함(false)", isHomerunCoveredRun(awayRun, [hr, awayRun]) === false);
}

// ── ④ 홈런 알림 표시 점수 보정 (resolveHomerunScore) ─────────────────────
// 홈런은 BoxScore 선감지로 ev.snapshot이 득점 반영 전(0:0)일 수 있다 → 생존 홈런 알림이
// 0:0을 그대로 보여주던 사고(고객 #SSLG). 현재 라이브 점수·매칭 run으로 보정, 미반영이면 defer.
function mkSnap(awayScore: number, homeScore: number): GameEvent["snapshot"] {
  return { awayScore, homeScore, balls: 0, strikes: 0, outs: 0, runners: { first: null, second: null, third: null }, pitcher: "", batter: "" };
}
function mkHr(snapAway: number, snapHome: number, ts = "2026-06-24T10:43:48.000Z"): GameEvent {
  return mkGE({ type: "at_bat_homerun", inning: 4, isTop: false, timestamp: ts, detail: { batter: "오스틴" }, snapshot: mkSnap(snapAway, snapHome) });
}
{
  const HT = Date.parse("2026-06-24T10:43:48.000Z");
  const fresh = HT + 10_000;   // 10s — 1폴링 안(신선)
  const old = HT + 120_000;    // 120s — waitMs(75s) 경과
  const hr00 = mkHr(0, 0);

  // 1) 교차폴링 poll N: 현재 0:0, run 없음, 신선 → defer(0:0 발송 방지)
  let r = resolveHomerunScore(hr00, [hr00], 0, 0, fresh);
  assert("홈런점수: 교차폴링 미반영(신선) → defer", r.defer === true, r);

  // 2) 교차폴링 poll N+1: 라이브 현재 점수 0:1로 상승 → 발송 0:1
  r = resolveHomerunScore(hr00, [hr00], 0, 1, fresh);
  assert("홈런점수: 현재 점수 상승 → 발송 0:1", r.defer === false && r.awayScore === 0 && r.homeScore === 1, r);

  // 3) 매칭 run_scored snapshot으로 보정 (g 현재가 아직 stale 0:0이어도)
  const run = mkGE({ type: "run_scored", inning: 4, isTop: false, timestamp: "2026-06-24T10:44:03.000Z", detail: { scoringSide: "home" }, snapshot: mkSnap(0, 1) });
  r = resolveHomerunScore(hr00, [hr00, run], 0, 0, fresh);
  assert("홈런점수: 매칭 run으로 보정 → 0:1", r.defer === false && r.homeScore === 1, r);

  // 4) age-out: 미반영이어도 waitMs 경과 시 발송(무한 보류 방지)
  r = resolveHomerunScore(hr00, [hr00], 0, 0, old);
  assert("홈런점수: 미반영 age-out → 발송", r.defer === false, r);

  // 5) 같은-폴링(snapshot 0:1 = 현재 0:1, 점수 이미 반영) age-out → 정확 0:1
  const hr01 = mkHr(0, 1);
  r = resolveHomerunScore(hr01, [hr01], 0, 1, old);
  assert("홈런점수: 같은-폴링 age-out → 0:1 정확", r.defer === false && r.homeScore === 1, r);

  // 6) 선행 득점 후 상승(snapshot 0:3 → 현재 0:4) → 0:4
  const hr03 = mkHr(0, 3);
  r = resolveHomerunScore(hr03, [hr03], 0, 4, fresh);
  assert("홈런점수: 선행득점 후 상승 → 0:4", r.defer === false && r.homeScore === 4, r);

  // 7) 선행 득점 미반영(snapshot 0:3 = 현재 0:3, 신선) → defer (0:3 stale 방지)
  r = resolveHomerunScore(hr03, [hr03], 0, 3, fresh);
  assert("홈런점수: 선행득점 미반영(신선) → defer", r.defer === true, r);
}

// ── ⑤ 교차-폴링 유령 단타 (resolvePhantomSingle / inheritHitRbi) ────────────
// BoxScore H(안타)가 홈런/장타 카운트보다 먼저 갱신돼, 같은 타석 홈런이 "안타로 N타점"으로
// 먼저 발송되는 사고(고객 2026-06-27 오스틴 만루홈런). 적시 단타를 한 폴링 확인 → 같은 타자
// 장타/홈런이 잡히면 단타 억제 + 장타/홈런이 타점 물려받아 "홈런으로 N타점" 한 건으로 합침.
function mkHit(o: { type: GameEvent["type"]; batter: string; inning: number; isTop: boolean; ts: string; rbi?: number }): GameEvent {
  return mkGE({
    type: o.type, inning: o.inning, isTop: o.isTop, timestamp: o.ts,
    detail: o.rbi !== undefined ? { batter: o.batter, rbi: o.rbi } : { batter: o.batter },
  });
}
{
  const ST = "2026-06-27T10:43:00.000Z";
  const sMs = Date.parse(ST);
  const fresh = sMs + 10_000;                       // 10s — 확인창 안(신선)
  const stale = sMs + PHANTOM_SINGLE_WAIT_MS + 5_000; // 확인창 경과

  const single4 = mkHit({ type: "at_bat_hit", batter: "오스틴", inning: 4, isTop: false, ts: ST, rbi: 4 });
  const single0 = mkHit({ type: "at_bat_hit", batter: "오스틴", inning: 4, isTop: false, ts: ST, rbi: 0 });
  // 단타 ~60s 뒤 따라잡힌 홈런(자기 rbi 0 = 타점이 단타에 먼저 귀속됨)
  const hrLate = mkHit({ type: "at_bat_homerun", batter: "오스틴", inning: 4, isTop: false, ts: "2026-06-27T10:44:00.000Z", rbi: 0 });

  // 1) 0타점 단타 → 즉시 발송(유령 후보 아님)
  assert("유령단타: 0타점 단타 → send", resolvePhantomSingle(single0, [single0], fresh) === "send");
  // 2) 적시 단타, 장타 미확인, 신선 → defer(다음 폴링 확인)
  assert("유령단타: 적시 단타 신선 → defer", resolvePhantomSingle(single4, [single4], fresh) === "defer");
  // 3) 적시 단타, 장타 미확인, 확인창 경과 → send(진짜 적시타)
  assert("유령단타: 적시 단타 stale → send", resolvePhantomSingle(single4, [single4], stale) === "send");
  // 4) 같은 타자 홈런이 직후 잡힘 → suppress(유령)
  assert("유령단타: 직후 홈런 → suppress", resolvePhantomSingle(single4, [single4, hrLate], fresh) === "suppress");
  // 5) 다른 타자 홈런 → 억제 안 함(신선이라 defer)
  const otherHr = mkHit({ type: "at_bat_homerun", batter: "박동원", inning: 4, isTop: false, ts: "2026-06-27T10:44:00.000Z", rbi: 0 });
  assert("유령단타: 다른 타자 홈런 → defer(억제X)", resolvePhantomSingle(single4, [single4, otherHr], fresh) === "defer");
  // 6) 반대 half 홈런 → 억제 안 함
  const topHr = mkHit({ type: "at_bat_homerun", batter: "오스틴", inning: 4, isTop: true, ts: "2026-06-27T10:44:00.000Z", rbi: 0 });
  assert("유령단타: 반대 half 홈런 → defer(억제X)", resolvePhantomSingle(single4, [single4, topHr], fresh) === "defer");
  // 7) 홈런이 단타보다 *먼저*(et<st) → 억제 안 함(이전 타석 홈런 보호)
  const hrBefore = mkHit({ type: "at_bat_homerun", batter: "오스틴", inning: 4, isTop: false, ts: "2026-06-27T10:40:00.000Z", rbi: 1 });
  assert("유령단타: 이전 홈런(et<st) → defer(억제X)", resolvePhantomSingle(single4, [single4, hrBefore], fresh) === "defer");

  // inheritHitRbi: 홈런이 유령 단타 타점을 물려받음
  // 8) 홈런 rbi 0 + 직전 유령 단타 rbi 4 → 4 물려받음
  assert("타점상속: 홈런 rbi0 + 유령단타 rbi4 → 4", inheritHitRbi(hrLate, [single4, hrLate]) === 4, inheritHitRbi(hrLate, [single4, hrLate]));
  // 9) 홈런이 자기 rbi 보유(같은-폴링 정상) → 자기 값
  const hrOwn = mkHit({ type: "at_bat_homerun", batter: "오스틴", inning: 4, isTop: false, ts: "2026-06-27T10:44:00.000Z", rbi: 3 });
  assert("타점상속: 홈런 자기 rbi3 → 3", inheritHitRbi(hrOwn, [hrOwn]) === 3);
  // 10) 단타가 홈런보다 뒤(et>ht) → 상속 안 함(0)
  const lateSingle = mkHit({ type: "at_bat_hit", batter: "오스틴", inning: 4, isTop: false, ts: "2026-06-27T10:45:00.000Z", rbi: 2 });
  assert("타점상속: 단타가 홈런 뒤 → 0", inheritHitRbi(hrLate, [hrLate, lateSingle]) === 0);
  // 11) 다른 타자 단타 → 상속 안 함(0)
  const otherSingle = mkHit({ type: "at_bat_hit", batter: "박동원", inning: 4, isTop: false, ts: ST, rbi: 4 });
  assert("타점상속: 다른 타자 단타 → 0", inheritHitRbi(hrLate, [otherSingle, hrLate]) === 0);
}

// ── ⑥ 그랜드슬램(만루홈런 4타점) 표기 감지 (하린아빠 2026-06-27) ─────────────
// 만루홈런 = 홈런 4타점. 홈런 rbi 최대 4(만루), 적시 단타 rbi 최대 3(주자 만루 시 3명만 득점,
// 타자는 1루) → rbi===4 ⟺ 그랜드슬램. player-highlight·game-score가 inheritHitRbi(홈런)===4로
// "그랜드슬램" 표기를 판정한다. 교차폴링으로 홈런 자기 rbi가 0이어도 유령 단타에서 상속해 유지.
{
  const T = "2026-06-27T11:10:00.000Z";
  // 1) 만루홈런 같은-폴링(자기 rbi 4) → inheritHitRbi 4 = 그랜드슬램
  const grandSlam = mkHit({ type: "at_bat_homerun", batter: "오스틴", inning: 7, isTop: false, ts: T, rbi: 4 });
  assert("그랜드슬램: 홈런 자기 rbi4 → 4(그랜드슬램)", inheritHitRbi(grandSlam, [grandSlam]) === 4);
  // 2) 교차폴링 만루홈런(자기 rbi0 + 유령 단타 rbi4) → 4 상속 = 그랜드슬램 판정 유지(#473 시나리오)
  const gsHrLate = mkHit({ type: "at_bat_homerun", batter: "오스틴", inning: 7, isTop: false, ts: "2026-06-27T11:11:00.000Z", rbi: 0 });
  const gsSingle4 = mkHit({ type: "at_bat_hit", batter: "오스틴", inning: 7, isTop: false, ts: T, rbi: 4 });
  assert("그랜드슬램: 교차폴링 홈런 rbi0 + 유령단타4 → 4", inheritHitRbi(gsHrLate, [gsSingle4, gsHrLate]) === 4);
  // 3) 3타점 홈런(만루 아님) → 4 아님 = 일반 "홈런으로 3타점"
  const hr3 = mkHit({ type: "at_bat_homerun", batter: "오스틴", inning: 7, isTop: false, ts: T, rbi: 3 });
  assert("그랜드슬램 아님: 3타점 홈런 → 3(일반 홈런)", inheritHitRbi(hr3, [hr3]) === 3);
}

console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
