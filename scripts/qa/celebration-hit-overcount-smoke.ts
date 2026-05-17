/**
 * Regression smoke for the 2026-05-16 celebration over-emit bug.
 *
 * Why
 * ---
 * KBO BoxScore is occasionally lag-inconsistent across polls: an extra-base
 * hit (2B/3B/HR) lands in the per-at-bat cells *before* the `hits` aggregate
 * increments. The earlier poll observes `hits=0, hr=1` (intermediate), the
 * later poll observes `hits=1, hr=1` (stable), and a naive
 * `diff.hits - diff.xbh` 1B count attributes the lag delta as a +1 single —
 * minting a bogus `at_bat_hit` 셀레머니 right after the real HR/2B/3B event.
 *
 * Original bug shape: `at_bat_hit-...-0` (16 occurrences across 4 games on
 * 2026-05-16). 삼순이's PR #88 v1 review correctly caught that a
 * skip-on-inconsistent guard alone doesn't help because nextState would
 * still record the inconsistent snapshot, so the next stable poll then
 * mints `at_bat_hit-...-1` (no longer `-0` but still bogus).
 *
 * Fix shape: drive 1B count off *cumulative derived* singles on BOTH sides
 * of the diff (`singlesAt(state) = max(0, hits - hr - h2b - h3b)`). The
 * inconsistent intermediate clamps to 0; the lag delta is absorbed
 * naturally without needing to skip or rewrite nextState.
 *
 * Assertions — using REAL route order (poll-A → nextState → poll-B):
 *   1. HR lag race (the prod scenario): zero `at_bat_hit` across both polls.
 *   2. 2B lag race: same.
 *   3. Clean 1B still fires exactly one `at_bat_hit`.
 *   4. Inconsistent curr-state alone: zero `at_bat_*` for that batter.
 *   5. No event id ever ends with `-0` (singles idx is 1-based).
 *   6. Extra cumulative-stat-correction defense: stat that goes BACKWARDS
 *      between polls (KBO occasionally retracts a hit on official review)
 *      mints zero negative-idx events.
 */
import {
  generateEvents,
  type PrevGameState,
} from "@/lib/event-generator";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import type { BatterRecord, GameDetailResponse } from "@/app/api/game-detail/route";
import type { GameEvent } from "@/types/game-events";

const GAME_ID = "20260516TEST0";

function mkLive(overrides: Partial<LiveGameData> = {}): LiveGameData {
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
    currentBatter: "한동희",
    currentPitcher: "투수A",
    stadium: "",
    startTime: "",
    statusCode: 4,
    statusInfo: "",
    inningHalfDisplay: "5말",
    ...overrides,
  } as LiveGameData;
}

function mkBatter(overrides: Partial<BatterRecord> & { name: string }): BatterRecord {
  return {
    order: 4,
    position: "지",
    positionFull: "지명",
    atBats: 0,
    hits: 0,
    rbi: 0,
    runs: 0,
    hr: 0,
    h2b: 0,
    h3b: 0,
    bb: 0,
    so: 0,
    sb: 0,
    avg: ".000",
    isSubstitute: false,
    ...overrides,
  } as BatterRecord;
}

function mkBox(home: BatterRecord[]): GameDetailResponse["boxScore"] {
  return {
    awayBatters: [],
    homeBatters: home,
    awayPitchers: [],
    homePitchers: [],
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

function eventIds(events: GameEvent[]): string[] {
  return events.map(e => e.id);
}

function ofType(events: GameEvent[], type: string): GameEvent[] {
  return events.filter(e => e.type === type);
}

// ---------------------------------------------------------------------------
// Scenario 1: HR lag race — REAL ROUTE ORDER
//   prev: clean (hits=0, hr=0)
//   poll A: lag       (hits=0, hr=1)  → nextState saved as lag snapshot
//   poll B: stable    (hits=1, hr=1)  → diff against the lag snapshot
//
// Expected ACROSS both polls combined:
//   - exactly ONE at_bat_homerun (in poll A)
//   - ZERO at_bat_hit (neither poll)
//   - ZERO ids ending in `-0`
// ---------------------------------------------------------------------------
{
  const live = mkLive({ inning: 5, isTop: false, currentBatter: "한동희" });
  const prev: PrevGameState = {
    live,
    boxScore: mkBox([mkBatter({ name: "한동희", hits: 0, hr: 0 })]),
  };

  // Poll A: lag (hits=0, hr=1)
  const lagBox = mkBox([mkBatter({ name: "한동희", hits: 0, hr: 1 })]);
  const a = generateEvents(GAME_ID, prev, live, lagBox);

  // Poll B: stable (hits=1, hr=1) — diffed against a.nextState
  const stableBox = mkBox([mkBatter({ name: "한동희", hits: 1, hr: 1 })]);
  const b = generateEvents(GAME_ID, a.nextState, live, stableBox);

  const combined = [...a.events, ...b.events];
  assert(
    "S1: HR lag race — exactly ONE at_bat_homerun across both polls",
    ofType(combined, "at_bat_homerun").length === 1,
    eventIds(combined),
  );
  assert(
    "S1: HR lag race — ZERO at_bat_hit across both polls (route order)",
    ofType(combined, "at_bat_hit").length === 0,
    eventIds(combined),
  );
  assert(
    "S1: HR lag race — no event id ends with `-0`",
    combined.every(e => !e.id.endsWith("-0")),
    eventIds(combined),
  );
}

// ---------------------------------------------------------------------------
// Scenario 2: 2B lag race — REAL ROUTE ORDER
// ---------------------------------------------------------------------------
{
  const live = mkLive({ currentBatter: "타자B" });
  const prev: PrevGameState = {
    live,
    boxScore: mkBox([mkBatter({ name: "타자B", hits: 0, h2b: 0 })]),
  };
  const lagBox = mkBox([mkBatter({ name: "타자B", hits: 0, h2b: 1 })]);
  const a = generateEvents(GAME_ID, prev, live, lagBox);

  const stableBox = mkBox([mkBatter({ name: "타자B", hits: 1, h2b: 1 })]);
  const b = generateEvents(GAME_ID, a.nextState, live, stableBox);

  const combined = [...a.events, ...b.events];
  assert(
    "S2: 2B lag race — exactly ONE at_bat_double across both polls",
    ofType(combined, "at_bat_double").length === 1,
    eventIds(combined),
  );
  assert(
    "S2: 2B lag race — ZERO at_bat_hit across both polls",
    ofType(combined, "at_bat_hit").length === 0,
    eventIds(combined),
  );
}

// ---------------------------------------------------------------------------
// Scenario 3: pure single still works
// ---------------------------------------------------------------------------
{
  const live = mkLive({ currentBatter: "타자C" });
  const prev: PrevGameState = {
    live,
    boxScore: mkBox([mkBatter({ name: "타자C", hits: 0 })]),
  };
  const box = mkBox([mkBatter({ name: "타자C", hits: 1 })]);
  const r = generateEvents(GAME_ID, prev, live, box);

  const hits = ofType(r.events, "at_bat_hit");
  assert(
    "S3: pure 1B emits ONE at_bat_hit",
    hits.length === 1,
    eventIds(r.events),
  );
  assert(
    "S3: at_bat_hit idx is 1 (not 0)",
    hits[0]?.id.endsWith("-타자C-1") === true,
    hits[0]?.id,
  );
}

// ---------------------------------------------------------------------------
// Scenario 4: inconsistent curr-state alone (single poll) — clamped to 0
// ---------------------------------------------------------------------------
{
  const live = mkLive({ currentBatter: "타자D" });
  const prev: PrevGameState = {
    live,
    boxScore: mkBox([mkBatter({ name: "타자D", hits: 0 })]),
  };
  // hits=0 but hr=1 → impossible aggregate; lag in progress
  const lagBox = mkBox([mkBatter({ name: "타자D", hits: 0, hr: 1 })]);
  const r = generateEvents(GAME_ID, prev, live, lagBox);

  // HR still fires (extra-base is monotonic, not driven by hits column),
  // but no bogus at_bat_hit
  assert(
    "S4: inconsistent curr-state — at_bat_homerun still fires (HR cell present)",
    ofType(r.events, "at_bat_homerun").length === 1,
    eventIds(r.events),
  );
  assert(
    "S4: inconsistent curr-state — ZERO at_bat_hit (clamped)",
    ofType(r.events, "at_bat_hit").length === 0,
    eventIds(r.events),
  );
}

// ---------------------------------------------------------------------------
// Scenario 5: backward stat correction (KBO occasionally retracts a hit
// on official review). With cumulative max(0, …) clamps, no bogus event.
// ---------------------------------------------------------------------------
{
  const live = mkLive({ currentBatter: "타자E" });
  const prev: PrevGameState = {
    live,
    boxScore: mkBox([mkBatter({ name: "타자E", hits: 1 })]),
  };
  // hits retracted 1 → 0 (rare but real)
  const correctedBox = mkBox([mkBatter({ name: "타자E", hits: 0 })]);
  const r = generateEvents(GAME_ID, prev, live, correctedBox);

  assert(
    "S5: backward stat correction — ZERO at_bat_* emitted",
    r.events.filter(e => e.type.startsWith("at_bat_")).length === 0,
    eventIds(r.events),
  );
}

// ---------------------------------------------------------------------------
// Scenario 6: 3-poll genuine multi-AB sequence still increments correctly
//   AB1: HR
//   AB2: 1B (clean single)
//   AB3: another 1B
// ---------------------------------------------------------------------------
{
  const live = mkLive({ currentBatter: "타자F" });
  const prev0: PrevGameState = {
    live,
    boxScore: mkBox([mkBatter({ name: "타자F", hits: 0, hr: 0 })]),
  };
  // AB1: HR with lag race (mimics prod)
  const lag1 = mkBox([mkBatter({ name: "타자F", hits: 0, hr: 1 })]);
  const r1 = generateEvents(GAME_ID, prev0, live, lag1);
  const stable1 = mkBox([mkBatter({ name: "타자F", hits: 1, hr: 1 })]);
  const r2 = generateEvents(GAME_ID, r1.nextState, live, stable1);

  // AB2: clean +1 single (hits 1→2)
  const stable2 = mkBox([mkBatter({ name: "타자F", hits: 2, hr: 1 })]);
  const r3 = generateEvents(GAME_ID, r2.nextState, live, stable2);

  // AB3: clean +1 single (hits 2→3)
  const stable3 = mkBox([mkBatter({ name: "타자F", hits: 3, hr: 1 })]);
  const r4 = generateEvents(GAME_ID, r3.nextState, live, stable3);

  const all = [...r1.events, ...r2.events, ...r3.events, ...r4.events];
  const hrs = ofType(all, "at_bat_homerun");
  const hits = ofType(all, "at_bat_hit");

  assert(
    "S6: 3-AB sequence — exactly ONE at_bat_homerun (idx 1)",
    hrs.length === 1 && hrs[0]?.id.endsWith("-타자F-1") === true,
    hrs.map(e => e.id),
  );
  assert(
    "S6: 3-AB sequence — exactly TWO at_bat_hit with idx 1,2",
    hits.length === 2 &&
      hits[0]?.id.endsWith("-타자F-1") === true &&
      hits[1]?.id.endsWith("-타자F-2") === true,
    hits.map(e => e.id),
  );
}

// ---------------------------------------------------------------------------
// Scenario 7: Source-switch XBH regression — the 2026-05-17 bug class
//   prev: batter has 1 double (hits=2, h2b=1) from source A (KBO)
//   curr: source B (Naver) has stale h2b=0 (regression), hits=2
//   expected: ZERO at_bat_hit (regression-inflated singles suppressed)
// ---------------------------------------------------------------------------
{
  const live = mkLive({ inning: 6, isTop: true, currentBatter: "이진영" });
  const prev: PrevGameState = {
    live,
    boxScore: mkBox([mkBatter({ name: "이진영", hits: 2, h2b: 1 })]),
  };
  // Source switch: h2b regresses 1→0 while hits stays 2
  const regressedBox = mkBox([mkBatter({ name: "이진영", hits: 2, h2b: 0 })]);
  const r = generateEvents(GAME_ID, prev, live, regressedBox);

  assert(
    "S7: XBH regression (h2b 1→0) — ZERO at_bat_hit",
    ofType(r.events, "at_bat_hit").length === 0,
    eventIds(r.events),
  );
  assert(
    "S7: XBH regression — ZERO at_bat_double (no re-emit)",
    ofType(r.events, "at_bat_double").length === 0,
    eventIds(r.events),
  );
}

// ---------------------------------------------------------------------------
// Scenario 8: Source-switch regression + new hit in same poll
//   prev: hits=2, h2b=1 (source A)
//   curr: hits=3, h2b=0 (source B, regression + new hit)
//   expected: singles suppressed (regression guard), XBH delta=0
//   The real single recovers on next stable poll.
// ---------------------------------------------------------------------------
{
  const live = mkLive({ inning: 6, isTop: false, currentBatter: "힐리어드" });
  const prev: PrevGameState = {
    live,
    boxScore: mkBox([mkBatter({ name: "힐리어드", hits: 2, h2b: 1, hr: 0 })]),
  };
  const regressedBox = mkBox([mkBatter({ name: "힐리어드", hits: 3, h2b: 0, hr: 0 })]);
  const a = generateEvents(GAME_ID, prev, live, regressedBox);

  assert(
    "S8: regression + hits bump — ZERO at_bat_hit (safe skip)",
    ofType(a.events, "at_bat_hit").length === 0,
    eventIds(a.events),
  );

  // Recovery poll: source stabilises (h2b=1, hits=3)
  const stableBox = mkBox([mkBatter({ name: "힐리어드", hits: 3, h2b: 1, hr: 0 })]);
  const b = generateEvents(GAME_ID, a.nextState, live, stableBox);

  // Known limitation: the single that happened during regression is
  // permanently lost. nextState from the regression poll saved h2b=0,
  // so prevSingles = max(0, 3-0) = 3 while currSingles = max(0, 3-1) = 2.
  // singleDelta = max(0, 2-3) = 0. The double re-emits (h2bDelta=1)
  // but dedupes harmlessly by event_id. Acceptable trade-off:
  // missing one celebration during source-switch > false positive.
  assert(
    "S8: recovery poll — single NOT recovered (known limitation)",
    ofType(b.events, "at_bat_hit").length === 0,
    eventIds(b.events),
  );
  assert(
    "S8: recovery poll — double re-emits (deduped by event_id)",
    ofType(b.events, "at_bat_double").length === 1,
    eventIds(b.events),
  );
}

// ---------------------------------------------------------------------------
// Scenario 9: Source-switch HR regression (HHKT 힐리어드 HR case)
//   prev: hits=1, hr=1 (source A — HR correctly counted)
//   curr: hits=1, hr=0 (source B — stale HR)
//   expected: ZERO at_bat_hit (would have been false single idx=1)
// ---------------------------------------------------------------------------
{
  const live = mkLive({ inning: 6, isTop: false, currentBatter: "힐리어드B" });
  const prev: PrevGameState = {
    live,
    boxScore: mkBox([mkBatter({ name: "힐리어드B", hits: 1, hr: 1 })]),
  };
  const regressedBox = mkBox([mkBatter({ name: "힐리어드B", hits: 1, hr: 0 })]);
  const r = generateEvents(GAME_ID, prev, live, regressedBox);

  assert(
    "S9: HR regression (hr 1→0) — ZERO at_bat_hit",
    ofType(r.events, "at_bat_hit").length === 0,
    eventIds(r.events),
  );
  assert(
    "S9: HR regression — ZERO at_bat_homerun (no re-emit)",
    ofType(r.events, "at_bat_homerun").length === 0,
    eventIds(r.events),
  );
}

// ---------------------------------------------------------------------------
// Scenario 10: Multi-batter mixed regression — only the regressed batter
//   is suppressed; other batters still emit normally.
// ---------------------------------------------------------------------------
{
  const live = mkLive({ inning: 3, isTop: false, currentBatter: "김주원" });
  const prev: PrevGameState = {
    live,
    boxScore: mkBox([
      mkBatter({ name: "김주원", hits: 1, hr: 1 }),   // will regress
      mkBatter({ name: "서건창", hits: 0, hr: 0 }),   // clean new single
    ]),
  };
  const box = mkBox([
    mkBatter({ name: "김주원", hits: 1, hr: 0 }),  // HR regression
    mkBatter({ name: "서건창", hits: 1, hr: 0 }),  // clean +1 single
  ]);
  const r = generateEvents(GAME_ID, prev, live, box);

  assert(
    "S10: multi-batter — 김주원 (regressed) ZERO at_bat_hit",
    r.events.filter(e => e.type === "at_bat_hit" && e.detail.batter === "김주원").length === 0,
    eventIds(r.events),
  );
  assert(
    "S10: multi-batter — 서건창 (clean) ONE at_bat_hit",
    r.events.filter(e => e.type === "at_bat_hit" && e.detail.batter === "서건창").length === 1,
    eventIds(r.events),
  );
}

// ---------------------------------------------------------------------------
// Scenario 11: 3B regression — same pattern as S7/S9 but for triples
// ---------------------------------------------------------------------------
{
  const live = mkLive({ inning: 1, isTop: false, currentBatter: "카메론" });
  const prev: PrevGameState = {
    live,
    boxScore: mkBox([mkBatter({ name: "카메론", hits: 1, h3b: 1 })]),
  };
  const regressedBox = mkBox([mkBatter({ name: "카메론", hits: 1, h3b: 0 })]);
  const r = generateEvents(GAME_ID, prev, live, regressedBox);

  assert(
    "S11: 3B regression (h3b 1→0) — ZERO at_bat_hit",
    ofType(r.events, "at_bat_hit").length === 0,
    eventIds(r.events),
  );
}

// ---------------------------------------------------------------------------
// Scenario 12: Hits-first lag within same source (NOT source-switch)
//   prev: hits=0, h2b=0
//   curr: hits=1, h2b=0 (hit column updated, h2b hasn't yet)
//   This case is NOT caught by XBH regression guard (no regression)
//   but IS mitigated by the monotonic effective clamp if h2b eventually
//   arrives. Document the behavior: single IS emitted (false positive),
//   but the subsequent stable poll won't double-emit the double because
//   delta is already absorbed by the previous nextState.
// ---------------------------------------------------------------------------
{
  const live = mkLive({ inning: 6, isTop: false, currentBatter: "김성윤" });
  const prev: PrevGameState = {
    live,
    boxScore: mkBox([mkBatter({ name: "김성윤", hits: 0, h2b: 0 })]),
  };
  // Hits-first lag: hit column landed, h2b hasn't yet (same source, no regression)
  const lagBox = mkBox([mkBatter({ name: "김성윤", hits: 1, h2b: 0 })]);
  const a = generateEvents(GAME_ID, prev, live, lagBox);

  // Known limitation: false single IS emitted (no regression signal to detect).
  // This is the residual risk class — same-source column-order lag.
  // Documenting expected behavior so future fixes can target it.
  const hitCount = ofType(a.events, "at_bat_hit").length;
  assert(
    "S12: hits-first lag — single emitted (known limitation, no regression signal)",
    hitCount === 1,
    { hitCount, events: eventIds(a.events) },
  );

  // Stable poll: h2b arrives
  const stableBox = mkBox([mkBatter({ name: "김성윤", hits: 1, h2b: 1 })]);
  const b = generateEvents(GAME_ID, a.nextState, live, stableBox);

  // Double emits (h2bDelta=1). The false single from above persists as a
  // separate event_id. Both are in event_history — this is the residual
  // risk vs the regression class which was 6x more frequent.
  assert(
    "S12: stable poll — double emits on h2b catchup",
    ofType(b.events, "at_bat_double").length === 1,
    eventIds(b.events),
  );
  assert(
    "S12: stable poll — ZERO additional singles",
    ofType(b.events, "at_bat_hit").length === 0,
    eventIds(b.events),
  );
}

// ---------------------------------------------------------------------------
// Scenario 13: Post-game-end burst guard
//   Game ended (isLive=false). Subsequent poll delivers a late BoxScore
//   stat correction. No events should be emitted.
// ---------------------------------------------------------------------------
{
  const endedLive = mkLive({ isLive: false, inning: 9, isTop: false });
  const prev: PrevGameState = {
    live: endedLive,
    boxScore: mkBox([mkBatter({ name: "타자G", hits: 2, hr: 1 })]),
  };
  // Late stat correction: hits 2→3 after game ended
  const lateBox = mkBox([mkBatter({ name: "타자G", hits: 3, hr: 1 })]);
  const r = generateEvents(GAME_ID, prev, endedLive, lateBox);

  assert(
    "S13: post-game-end — ZERO at_bat_* events",
    r.events.filter(e => e.type.startsWith("at_bat_")).length === 0,
    eventIds(r.events),
  );
  assert(
    "S13: post-game-end — ZERO total events",
    r.events.length === 0,
    eventIds(r.events),
  );
}

// ---------------------------------------------------------------------------
// Scenario 14: Game-end transition still emits game_end correctly
// ---------------------------------------------------------------------------
{
  const livePrev = mkLive({ isLive: true, inning: 9, isTop: false, awayScore: 3, homeScore: 5 });
  const endedCurr = mkLive({ isLive: false, inning: 9, isTop: false, awayScore: 3, homeScore: 5 });
  const prev: PrevGameState = {
    live: livePrev,
    boxScore: mkBox([mkBatter({ name: "타자H", hits: 2 })]),
  };
  const box = mkBox([mkBatter({ name: "타자H", hits: 2 })]);
  const r = generateEvents(GAME_ID, prev, endedCurr, box);

  assert(
    "S14: game-end transition — exactly ONE game_end event",
    ofType(r.events, "game_end").length === 1,
    eventIds(r.events),
  );
  assert(
    "S14: game-end transition — no BoxScore-derived events",
    r.events.filter(e => e.type.startsWith("at_bat_")).length === 0,
    eventIds(r.events),
  );
}

if (failed > 0) {
  console.log(`\n❌ ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✅ All assertions passed");
