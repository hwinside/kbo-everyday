/**
 * 실점 투수 귀속(실점 기준) smoke — run_scored detail.pitcher (2026-07-07).
 *
 * Why
 * ---
 * 실점 알림(my_team_concede)의 투수 표기는 "자책 판정"이 아니라 *실점 기준*
 * (하린아빠 2026-07-07): KBO 기록상 실점(R)이 오른 투수에게 귀속한다. 마운드
 * 투수 스냅샷만 쓰면 이닝 중 교체 후 승계주자 홈인 케이스에서 새 투수에게
 * 오귀속된다 — 실제 실점은 주자를 내보낸 앞 투수 기록.
 *
 * Fix shape: event-generator의 run_scored 발화 시 수비팀 boxScore 투수별
 * R 델타(prev vs curr)로 실점이 오른 투수를 detail.pitcher에 기록. score와
 * boxScore 반영이 폴링 어긋나면 빈값(생략) → 알림 레이어가 snapshot.pitcher
 * (마운드 투수)로 폴백.
 *
 * Assertions:
 *   1. 승계주자 실점: 마운드는 교체투수B, R델타는 앞투수A → detail.pitcher="A"
 *   2. 일반 실점: 마운드 투수 본인 R 증가 → 본인 이름
 *   3. boxScore 미반영 폴링(lag): detail.pitcher 없음 (스냅샷 폴백 경로)
 *   4. 한 폴링에 두 투수 R 증가: "A, B" join
 *   5. 원정 득점 → 홈 투수진에서 귀속 (수비 side 매핑)
 *   6. 기존 필드 회귀 없음: rbi/scoringSide/id 불변
 */
import {
  generateEvents,
  type PrevGameState,
} from "@/lib/event-generator";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import type { PitcherRecord, GameDetailResponse } from "@/app/api/game-detail/route";
import type { GameEvent } from "@/types/game-events";

const GAME_ID = "20260707TEST0";

function mkLive(overrides: Partial<LiveGameData> = {}): LiveGameData {
  return {
    gameId: GAME_ID,
    isLive: true,
    inning: 7,
    isTop: true,
    balls: 0,
    strikes: 0,
    outs: 1,
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
    currentBatter: "타자X",
    currentPitcher: "교체투수B",
    stadium: "",
    startTime: "",
    statusCode: 4,
    statusInfo: "",
    inningHalfDisplay: "7초",
    ...overrides,
  } as LiveGameData;
}

function mkPitcher(overrides: Partial<PitcherRecord> & { name: string }): PitcherRecord {
  return {
    inningsPitched: "1",
    decision: "",
    pitchCount: 10,
    hits: 0,
    runs: 0,
    hr: 0,
    strikeouts: 0,
    walks: 0,
    earnedRuns: 0,
    battersFaced: 4,
    atBats: 4,
    era: "0.00",
    ...overrides,
  } as PitcherRecord;
}

function mkBox(
  { awayPitchers = [], homePitchers = [] }: {
    awayPitchers?: PitcherRecord[];
    homePitchers?: PitcherRecord[];
  },
): GameDetailResponse["boxScore"] {
  return {
    awayBatters: [],
    homeBatters: [],
    awayPitchers,
    homePitchers,
  } as unknown as GameDetailResponse["boxScore"];
}

let failed = 0;
function assert(label: string, cond: boolean, detail?: unknown) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`[${tag}] ${label}`);
  if (!cond) {
    failed++;
    if (detail !== undefined) console.log("  detail:", detail);
  }
}

function runScoredOf(events: GameEvent[]): GameEvent[] {
  return events.filter(e => e.type === "run_scored");
}

// ---------------------------------------------------------------------------
// Scenario 1: 승계주자 실점 — 마운드는 교체투수B, R은 앞투수A에게 증가
//   원정(away) 득점 → 수비 = 홈 투수진. detail.pitcher는 "앞투수A"여야 한다
//   (마운드 스냅샷이면 "교체투수B"로 오귀속 — 이 smoke가 잡는 회귀).
// ---------------------------------------------------------------------------
{
  const prevLive = mkLive({ awayScore: 2, homeScore: 3 });
  const prev: PrevGameState = {
    live: prevLive,
    boxScore: mkBox({
      homePitchers: [
        mkPitcher({ name: "앞투수A", runs: 2 }),
        mkPitcher({ name: "교체투수B", runs: 0 }),
      ],
    }),
  };
  const currLive = mkLive({ awayScore: 3, homeScore: 3 });
  const currBox = mkBox({
    homePitchers: [
      mkPitcher({ name: "앞투수A", runs: 3 }), // 승계주자 홈인 → 앞투수 실점
      mkPitcher({ name: "교체투수B", runs: 0 }),
    ],
  });
  const { events } = generateEvents(GAME_ID, prev, currLive, currBox);
  const rs = runScoredOf(events);
  assert("승계주자: run_scored 1건", rs.length === 1, rs);
  assert("승계주자: 앞투수A 귀속(마운드 교체투수B 아님)", rs[0]?.detail.pitcher === "앞투수A", rs[0]?.detail);
  assert("승계주자: scoringSide=away 유지", rs[0]?.detail.scoringSide === "away", rs[0]?.detail);
  assert("승계주자: rbi=1 유지", rs[0]?.detail.rbi === 1, rs[0]?.detail);
  assert("승계주자: id 포맷 불변", rs[0]?.id === `${GAME_ID}-run_scored-3-3-away`, rs[0]?.id);
}

// ---------------------------------------------------------------------------
// Scenario 2: 일반 실점 — 마운드 투수 본인 R 증가 → 본인 이름
// ---------------------------------------------------------------------------
{
  const prev: PrevGameState = {
    live: mkLive({ awayScore: 0, homeScore: 0 }),
    boxScore: mkBox({ homePitchers: [mkPitcher({ name: "교체투수B", runs: 0 })] }),
  };
  const currBox = mkBox({ homePitchers: [mkPitcher({ name: "교체투수B", runs: 1 })] });
  const { events } = generateEvents(GAME_ID, prev, mkLive({ awayScore: 1, homeScore: 0 }), currBox);
  const rs = runScoredOf(events);
  assert("일반: 본인 귀속", rs[0]?.detail.pitcher === "교체투수B", rs[0]?.detail);
}

// ---------------------------------------------------------------------------
// Scenario 3: boxScore lag — score만 오르고 투수 R 미반영 → pitcher 생략(폴백 경로)
// ---------------------------------------------------------------------------
{
  const box = mkBox({ homePitchers: [mkPitcher({ name: "교체투수B", runs: 0 })] });
  const prev: PrevGameState = {
    live: mkLive({ awayScore: 0, homeScore: 0 }),
    boxScore: box,
  };
  const { events } = generateEvents(GAME_ID, prev, mkLive({ awayScore: 1, homeScore: 0 }), box);
  const rs = runScoredOf(events);
  assert("lag: run_scored는 발화", rs.length === 1, rs);
  assert("lag: pitcher 생략(스냅샷 폴백 위임)", rs[0]?.detail.pitcher === undefined, rs[0]?.detail);
}

// ---------------------------------------------------------------------------
// Scenario 4: 한 폴링에 두 투수 R 증가(교체 직후 대량 실점) → join
// ---------------------------------------------------------------------------
{
  const prev: PrevGameState = {
    live: mkLive({ awayScore: 0, homeScore: 0 }),
    boxScore: mkBox({
      homePitchers: [
        mkPitcher({ name: "앞투수A", runs: 0 }),
        mkPitcher({ name: "교체투수B", runs: 0 }),
      ],
    }),
  };
  const currBox = mkBox({
    homePitchers: [
      mkPitcher({ name: "앞투수A", runs: 1 }),
      mkPitcher({ name: "교체투수B", runs: 1 }),
    ],
  });
  const { events } = generateEvents(GAME_ID, prev, mkLive({ awayScore: 2, homeScore: 0 }), currBox);
  const rs = runScoredOf(events);
  assert("복수: 'A, B' join", rs[0]?.detail.pitcher === "앞투수A, 교체투수B", rs[0]?.detail);
}

// ---------------------------------------------------------------------------
// Scenario 5: 홈 득점 → 수비 = 원정 투수진 매핑
// ---------------------------------------------------------------------------
{
  const prev: PrevGameState = {
    live: mkLive({ awayScore: 0, homeScore: 0, isTop: false, inningHalfDisplay: "7말" }),
    boxScore: mkBox({ awayPitchers: [mkPitcher({ name: "원정투수C", runs: 0 })] }),
  };
  const currBox = mkBox({ awayPitchers: [mkPitcher({ name: "원정투수C", runs: 1 })] });
  const { events } = generateEvents(
    GAME_ID, prev,
    mkLive({ awayScore: 0, homeScore: 1, isTop: false, inningHalfDisplay: "7말" }),
    currBox,
  );
  const rs = runScoredOf(events);
  assert("홈득점: 원정 투수진에서 귀속", rs[0]?.detail.pitcher === "원정투수C", rs[0]?.detail);
  assert("홈득점: scoringSide=home", rs[0]?.detail.scoringSide === "home", rs[0]?.detail);
}

console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
