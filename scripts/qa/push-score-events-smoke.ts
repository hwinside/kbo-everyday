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
import { isHomerunCoveredRun } from "@/lib/notifications/score-dedupe";
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

console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
