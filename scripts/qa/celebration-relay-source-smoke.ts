/**
 * Smoke test for the Naver-relay celebration trigger source (2026-05-26).
 *
 * Why
 * ---
 * Celebration latency was 11–22s (KBO BoxScore lag). Switching the primary
 * trigger source to Naver relay drops this to 5–7s, but reintroduces a
 * cross-source dedupe risk: if relay-generated GameEvents and BoxScore-diff
 * GameEvents mint *different* ids for the same plate appearance, every play
 * fires twice (once per path).
 *
 * Contract
 * --------
 * Both generators MUST mint
 *   `${gameId}-${type}-${inningKey}-${normalizeBatterName(batter)}-${idx}`
 * where `idx` is the 1-based count of `(inning, side, batter, type)`
 * occurrences. useCelebration's module-level displayedEventIds then dedupes
 * the slower path automatically.
 *
 * Assertions
 * ----------
 *   T1: KBO diff and relay mint identical id for the same plate appearance.
 *   T2: Batter-name whitespace variants (KBO "엘리엇 어슨" vs relay "엘리엇어슨")
 *       collapse to the same id via shared normalizeBatterName.
 *   T3: Empty relay response still allows KBO BoxScore-diff fallback events.
 *   T4: Relay PlayEvents of type out/sacrifice/error/hbp/other are dropped
 *       (parity with BoxScore path which only celebrates hit/HR/walk/SO).
 *   T5: Same batter, same inning, same type repeated (rare but valid) →
 *       distinct events with idx 1, 2 (no collision).
 *   T6: Relay hit subtype routing — result text "1루타/2루타/3루타/홈런" maps
 *       to at_bat_hit / double / triple / homerun respectively.
 *   T7: Mid-game page entry materializes historical events; the count is
 *       correct and each id is unique (useCelebration's hasPrimedSeenRef
 *       seeds these as baseline in production).
 *   T8: Relay-generated GameEvents carry source === "relay" for telemetry.
 */

import {
  generateRelayEvents,
} from "@/lib/relay-event-generator";
import {
  generateEvents,
} from "@/lib/event-generator";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import type {
  BatterRecord,
  GameDetailResponse,
} from "@/app/api/game-detail/route";
import type {
  InningRelay,
  PlayEvent,
} from "@/app/api/game-relay/route";

const GAME_ID = "20260526TEST0";

function mkLive(over: Partial<LiveGameData> = {}): LiveGameData {
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
    currentBatter: "",
    currentPitcher: "투수A",
    stadium: "",
    startTime: "",
    statusCode: 4,
    statusInfo: "",
    inningHalfDisplay: "5말",
    ...over,
  } as LiveGameData;
}

function mkBatter(over: Partial<BatterRecord> & { name: string }): BatterRecord {
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
    ...over,
  } as BatterRecord;
}

function mkBox(
  home: BatterRecord[],
  away: BatterRecord[] = [],
): GameDetailResponse["boxScore"] {
  return {
    awayBatters: away,
    homeBatters: home,
    awayPitchers: [{ name: "투수A" } as unknown as NonNullable<GameDetailResponse["boxScore"]>["awayPitchers"][number]],
    homePitchers: [{ name: "투수H" } as unknown as NonNullable<GameDetailResponse["boxScore"]>["homePitchers"][number]],
  } as NonNullable<GameDetailResponse["boxScore"]>;
}

function mkPlay(over: Partial<PlayEvent> & { batterName: string }): PlayEvent {
  return {
    batterName: over.batterName,
    result: over.result ?? "결과",
    type: over.type ?? "hit",
    extras: over.extras,
  };
}

function mkInning(half: "top" | "bottom", inning: number, plays: PlayEvent[]): InningRelay {
  return {
    inning,
    half,
    teamName: half === "top" ? "Away" : "Home",
    plays,
  };
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

// ----- T1: 같은 plate appearance에서 KBO와 relay가 동일 id mint -----
{
  const live = mkLive({ inning: 5, isTop: false, currentBatter: "한동희" });
  const prevLive = mkLive({ inning: 5, isTop: false, currentBatter: "한동희" });
  const prevBox = mkBox([mkBatter({ name: "한동희", atBats: 1, hits: 0 })]);
  const currBox = mkBox([mkBatter({ name: "한동희", atBats: 2, hits: 1 })]);

  const { events: kboEvents } = generateEvents(
    GAME_ID,
    { live: prevLive, boxScore: prevBox },
    live,
    currBox,
  );
  const relayEvents = generateRelayEvents(
    GAME_ID,
    [mkInning("bottom", 5, [
      mkPlay({ batterName: "한동희", result: "우익수 앞 1루타", type: "hit" }),
    ])],
    live,
  );

  const kboHit = kboEvents.find(e => e.type === "at_bat_hit");
  const relayHit = relayEvents.find(e => e.type === "at_bat_hit");
  assert(
    "T1: KBO+relay 같은 1루타 → 동일 id (cross-source dedupe)",
    !!kboHit && !!relayHit && kboHit.id === relayHit.id,
    { kbo: kboHit?.id, relay: relayHit?.id },
  );
}

// ----- T2: Batter name 공백 차이 흡수 -----
{
  const live = mkLive({ inning: 6, isTop: true, currentBatter: "엘리엇 어슨" });
  const prevLive = mkLive({ inning: 6, isTop: true, currentBatter: "엘리엇 어슨" });
  const prevBox = mkBox([], [mkBatter({ name: "엘리엇 어슨", atBats: 1, hits: 0, hr: 0 })]);
  const currBox = mkBox([], [mkBatter({ name: "엘리엇 어슨", atBats: 2, hits: 1, hr: 1 })]);

  const { events: kboEvents } = generateEvents(
    GAME_ID,
    { live: prevLive, boxScore: prevBox },
    live,
    currBox,
  );
  // relay 응답엔 공백 없는 표기 ("엘리엇어슨")로 들어오는 경우 가정
  const relayEvents = generateRelayEvents(
    GAME_ID,
    [mkInning("top", 6, [
      mkPlay({ batterName: "엘리엇어슨", result: "좌측 담장 넘기는 홈런", type: "homerun" }),
    ])],
    live,
  );

  const kboHr = kboEvents.find(e => e.type === "at_bat_homerun");
  const relayHr = relayEvents.find(e => e.type === "at_bat_homerun");
  assert(
    "T2: KBO 공백 vs relay 미공백 batter → 동일 id (normalize 흡수)",
    !!kboHr && !!relayHr && kboHr.id === relayHr.id,
    { kbo: kboHr?.id, relay: relayHr?.id },
  );
}

// ----- T3: relay 빈 응답이어도 KBO diff fallback 동작 -----
{
  const live = mkLive({ inning: 3, isTop: false, currentBatter: "김선빈" });
  const prevLive = mkLive({ inning: 3, isTop: false, currentBatter: "김선빈" });
  const prevBox = mkBox([mkBatter({ name: "김선빈", atBats: 0, hits: 0, bb: 0 })]);
  const currBox = mkBox([mkBatter({ name: "김선빈", atBats: 0, hits: 0, bb: 1 })]);

  const { events: kboEvents } = generateEvents(
    GAME_ID,
    { live: prevLive, boxScore: prevBox },
    live,
    currBox,
  );
  const relayEvents = generateRelayEvents(GAME_ID, [], live);

  assert(
    "T3: relay 빈 응답 → KBO 볼넷 발화 (fallback)",
    kboEvents.some(e => e.type === "at_bat_walk"),
  );
  assert(
    "T3: relay 빈 응답 → relay 0건",
    relayEvents.length === 0,
  );
}

// ----- T4: relay의 out/sacrifice/error/hbp/other 무시 -----
{
  const live = mkLive({ inning: 7, isTop: true, currentBatter: "오스틴" });
  const relayEvents = generateRelayEvents(
    GAME_ID,
    [mkInning("top", 7, [
      mkPlay({ batterName: "오스틴", result: "유격수 땅볼 아웃", type: "out" }),
      mkPlay({ batterName: "오스틴", result: "희생 플라이", type: "sacrifice" }),
      mkPlay({ batterName: "오스틴", result: "유격수 실책", type: "error" }),
      mkPlay({ batterName: "오스틴", result: "몸에 맞는 볼", type: "hbp" }),
      mkPlay({ batterName: "오스틴", result: "?? 텍스트", type: "other" }),
    ])],
    live,
  );

  assert(
    "T4: relay out/sac/err/hbp/other → 발화 0건",
    relayEvents.length === 0,
    { events: relayEvents.map(e => e.type) },
  );
}

// ----- T5: 같은 이닝 같은 batter 두 번 같은 type → idx 1, 2 -----
{
  const live = mkLive({ inning: 4, isTop: false, currentBatter: "김지찬" });
  const relayEvents = generateRelayEvents(
    GAME_ID,
    [mkInning("bottom", 4, [
      mkPlay({ batterName: "김지찬", result: "중전 1루타", type: "hit" }),
      mkPlay({ batterName: "김지찬", result: "좌전 1루타", type: "hit" }),
    ])],
    live,
  );

  const hits = relayEvents.filter(e => e.type === "at_bat_hit");
  assert(
    "T5: 같은 이닝 동일 batter 1루타 2회 → 2 events",
    hits.length === 2,
    { count: hits.length },
  );
  assert(
    "T5: idx 1과 2로 구분 (cumIdx 누적)",
    hits.length === 2 && hits[0].id.endsWith("-1") && hits[1].id.endsWith("-2"),
    { ids: hits.map(h => h.id) },
  );
}

// ----- T6: Hit subtype 분류 (1루타/2루타/3루타/홈런) -----
{
  const live = mkLive({ inning: 1, isTop: true, currentBatter: "테스터" });
  const relayEvents = generateRelayEvents(
    GAME_ID,
    [mkInning("top", 1, [
      mkPlay({ batterName: "테스터1", result: "우전 1루타", type: "hit" }),
      mkPlay({ batterName: "테스터2", result: "좌중간 2루타", type: "hit" }),
      mkPlay({ batterName: "테스터3", result: "우측 3루타", type: "hit" }),
      mkPlay({ batterName: "테스터4", result: "좌측 담장 넘어가는 홈런", type: "hit" }),
    ])],
    live,
  );

  const types = relayEvents.map(e => e.type);
  assert(
    "T6: result 텍스트로 hit 세부 분류 (1루타/2루타/3루타/홈런)",
    types[0] === "at_bat_hit" &&
      types[1] === "at_bat_double" &&
      types[2] === "at_bat_triple" &&
      types[3] === "at_bat_homerun",
    { types },
  );
}

// ----- T7: Mid-game 진입 — 과거 history 모두 mint + 모두 unique id -----
{
  const live = mkLive({ inning: 5, isTop: false });
  const relayEvents = generateRelayEvents(
    GAME_ID,
    [
      mkInning("top", 1, [mkPlay({ batterName: "오스틴", result: "좌측 담장 넘기는 홈런", type: "homerun" })]),
      mkInning("bottom", 2, [mkPlay({ batterName: "한동희", result: "중전 1루타", type: "hit" })]),
      mkInning("top", 3, [mkPlay({ batterName: "엘리엇어슨", result: "좌중간 2루타", type: "hit" })]),
    ],
    live,
  );

  assert(
    "T7: 5회 진입 시 과거 events 모두 generation (3건)",
    relayEvents.length === 3,
    { count: relayEvents.length },
  );
  const uniqueIds = new Set(relayEvents.map(e => e.id));
  assert(
    "T7: 과거 events 모두 unique id (useCelebration의 hasPrimedSeenRef가 production에서 baseline 처리)",
    uniqueIds.size === relayEvents.length,
    { ids: relayEvents.map(e => e.id) },
  );
}

// ----- T8: relay path source = "relay" telemetry tagging -----
{
  const live = mkLive({ inning: 2, isTop: true });
  const relayEvents = generateRelayEvents(
    GAME_ID,
    [mkInning("top", 2, [mkPlay({ batterName: "박해민", result: "중전 1루타", type: "hit" })])],
    live,
  );

  assert(
    "T8: relay generator output.source === 'relay'",
    relayEvents.length === 1 && relayEvents.every(e => e.source === "relay"),
    { sources: relayEvents.map(e => e.source) },
  );
}

// =====================================================================
// Reflect 삼순 NO-GO review (2026-05-26) and self code-review (high effort)
// =====================================================================

// ----- T9: source-aware baseline — first batch per source seeds, second batch fires -----
// Mirrors the production processEvents per-source baseline logic in
// useCelebration.ts. The previous 8s wall-clock baseline would let relay's
// first batch (which always arrives with timestamp=now and full game history)
// flood as fresh celebrations if it landed after the 8s window.
{
  const primedSources = new Set<string>();
  const seen = new Set<string>();

  function simulateProcess(events: { id: string; source?: string }[]): string[] {
    const fired: string[] = [];
    const sourcesInBatch = new Set<string>();
    for (const ev of events) sourcesInBatch.add(ev.source ?? "_unknown");
    const sourcesToBaseline: string[] = [];
    for (const src of sourcesInBatch) {
      if (!primedSources.has(src)) {
        sourcesToBaseline.push(src);
        primedSources.add(src);
      }
    }
    if (sourcesToBaseline.length > 0) {
      for (const ev of events) {
        if (sourcesToBaseline.includes(ev.source ?? "_unknown")) seen.add(ev.id);
      }
    }
    for (const ev of events) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      fired.push(ev.id);
    }
    return fired;
  }

  // First relay batch — full history (3 events). Should fire 0.
  const firstBatchFired = simulateProcess([
    { id: "g-at_bat_homerun-2-T-a-1", source: "relay" },
    { id: "g-at_bat_hit-3-B-b-1", source: "relay" },
    { id: "g-at_bat_walk-4-T-c-1", source: "relay" },
  ]);
  assert(
    "T9: first relay full-history batch fires 0 celebrations (baseline seed only)",
    firstBatchFired.length === 0,
    { fired: firstBatchFired },
  );

  // Second relay batch — same 3 historical + 1 new. Only new should fire.
  const secondBatchFired = simulateProcess([
    { id: "g-at_bat_homerun-2-T-a-1", source: "relay" },
    { id: "g-at_bat_hit-3-B-b-1", source: "relay" },
    { id: "g-at_bat_walk-4-T-c-1", source: "relay" },
    { id: "g-at_bat_homerun-5-T-d-1", source: "relay" },
  ]);
  assert(
    "T9: second relay batch fires only the NEW id",
    secondBatchFired.length === 1 && secondBatchFired[0] === "g-at_bat_homerun-5-T-d-1",
    { fired: secondBatchFired },
  );

  // First KBO-diff batch arrives later — baseline-seeded independently.
  const firstKboBatchFired = simulateProcess([
    { id: "g-at_bat_hit-3-B-b-1", source: "kbo_diff" },  // same id as relay's, already in seen
    { id: "g-at_bat_double-6-B-e-1", source: "kbo_diff" },  // new for kbo_diff
  ]);
  assert(
    "T9: first kbo_diff batch ALSO baseline-seeded silently (the new id is seeded, not fired)",
    firstKboBatchFired.length === 0,
    { fired: firstKboBatchFired },
  );

  // Second kbo_diff batch with a different new id should fire.
  const secondKboBatchFired = simulateProcess([
    { id: "g-at_bat_homerun-7-T-f-1", source: "kbo_diff" },
  ]);
  assert(
    "T9: second kbo_diff batch fires the new id",
    secondKboBatchFired.length === 1 && secondKboBatchFired[0] === "g-at_bat_homerun-7-T-f-1",
    { fired: secondKboBatchFired },
  );
}

// ----- T10: resume (markResumeBoundary) re-arms per-source baseline -----
{
  const primedSources = new Set<string>();
  const seen = new Set<string>();

  function simulateProcess(events: { id: string; source?: string }[]): string[] {
    const fired: string[] = [];
    const sourcesInBatch = new Set<string>();
    for (const ev of events) sourcesInBatch.add(ev.source ?? "_unknown");
    const sourcesToBaseline: string[] = [];
    for (const src of sourcesInBatch) {
      if (!primedSources.has(src)) {
        sourcesToBaseline.push(src);
        primedSources.add(src);
      }
    }
    if (sourcesToBaseline.length > 0) {
      for (const ev of events) {
        if (sourcesToBaseline.includes(ev.source ?? "_unknown")) seen.add(ev.id);
      }
    }
    for (const ev of events) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      fired.push(ev.id);
    }
    return fired;
  }

  function markResumeBoundary() {
    primedSources.clear();
    // seenRef and pitcherKRef also clear in production, but for this baseline
    // test the seenRef is intentionally NOT cleared — we want to verify that
    // a re-armed baseline still suppresses re-delivered events even if seen
    // already has them. The actual production code clears seenRef in the
    // visibility-change handler INSIDE useCelebration? No — seenRef is NOT
    // cleared on resume (only queue/celebration are cleared). So re-delivered
    // events fail at seenRef-has check anyway. The baseline re-arm protects
    // NEW ids in the post-resume first batch that weren't seen before.
  }

  // Prime: first relay batch baselines 3 historical events.
  simulateProcess([
    { id: "g-hr-1", source: "relay" },
    { id: "g-hit-1", source: "relay" },
    { id: "g-walk-1", source: "relay" },
  ]);
  // Verify primed.
  const beforeResume = simulateProcess([{ id: "g-hr-99", source: "relay" }]);
  assert(
    "T10: post-prime new id fires (sanity)",
    beforeResume.length === 1,
  );

  // Resume: re-arm baseline.
  markResumeBoundary();

  // First post-resume relay batch — full history including new background plays.
  // The 3 historical (g-hr-1 / g-hit-1 / g-walk-1) are already in seen — filtered.
  // The new id "g-hr-bg-1" (occurred while backgrounded) MUST be baseline-seeded,
  // not fired.
  const postResumeFired = simulateProcess([
    { id: "g-hr-1", source: "relay" },
    { id: "g-hit-1", source: "relay" },
    { id: "g-walk-1", source: "relay" },
    { id: "g-hr-bg-1", source: "relay" },
  ]);
  assert(
    "T10: post-resume first relay batch fires 0 (including the new-while-backgrounded id, which is baseline-seeded)",
    postResumeFired.length === 0,
    { fired: postResumeFired },
  );

  // Second post-resume batch with a truly fresh play should fire.
  const postResumeSecondFired = simulateProcess([
    { id: "g-hr-bg-1", source: "relay" },  // already seen
    { id: "g-hr-live-1", source: "relay" },  // brand new post-resume
  ]);
  assert(
    "T10: second post-resume batch fires the truly-new id",
    postResumeSecondFired.length === 1 && postResumeSecondFired[0] === "g-hr-live-1",
    { fired: postResumeSecondFired },
  );
}

// ----- T11: same batter, same type, DIFFERENT inning → same id from both sources -----
// cumIdx must be GAME-WIDE (matching BoxScore's prevHr+1 semantics) for
// cross-source dedupe to work across multi-hit games.
{
  const live = mkLive({ inning: 6, isTop: false, currentBatter: "한동희" });
  // BoxScore: 2nd HR for 한동희 (prevHr=1, curr inning 6)
  const prevLive = mkLive({ inning: 6, isTop: false, currentBatter: "한동희" });
  const prevBox = mkBox([mkBatter({ name: "한동희", atBats: 3, hits: 1, hr: 1 })]);
  const currBox = mkBox([mkBatter({ name: "한동희", atBats: 4, hits: 2, hr: 2 })]);

  const { events: kboEvents } = generateEvents(
    GAME_ID,
    { live: prevLive, boxScore: prevBox },
    live,
    currBox,
  );
  // Relay: full history with both HRs across innings
  const relayEvents = generateRelayEvents(
    GAME_ID,
    [
      mkInning("bottom", 2, [mkPlay({ batterName: "한동희", result: "솔로 홈런", type: "homerun" })]),
      mkInning("bottom", 6, [mkPlay({ batterName: "한동희", result: "투런 홈런", type: "homerun" })]),
    ],
    live,
  );

  const kboHr2 = kboEvents.find(e => e.type === "at_bat_homerun");
  const relayHr2 = relayEvents.find(
    e => e.type === "at_bat_homerun" && e.inning === 6,
  );
  assert(
    "T11: 같은 batter 2nd HR (different inning) → KBO와 relay 동일 id (game-wide cumIdx)",
    !!kboHr2 && !!relayHr2 && kboHr2.id === relayHr2.id,
    { kbo: kboHr2?.id, relay: relayHr2?.id },
  );
  // Also verify the relay's inning-2 HR has idx=1 (first HR for batter)
  const relayHr1 = relayEvents.find(
    e => e.type === "at_bat_homerun" && e.inning === 2,
  );
  assert(
    "T11: relay 1st HR (inning 2) idx=1, 2nd HR (inning 6) idx=2",
    !!relayHr1 && relayHr1.id.endsWith("-1") && !!relayHr2 && relayHr2.id.endsWith("-2"),
    { idx1: relayHr1?.id, idx2: relayHr2?.id },
  );
}

// ----- T12 / T13: Local mirror of game-relay/route.ts internals -----
// Production helpers cannot be imported here because @/app/api/game-relay/route
// pulls in @/lib/supabase/admin which requires runtime env. These mini-mirrors
// MUST stay in sync with route.ts:120 (classifyResult) and route.ts:227
// (parseInningRelays). If you change either production helper, update these
// counterparts and add the relevant assertion below.

type MirrorPlayType = "homerun" | "hit" | "walk" | "strikeout" | "out" | "hbp" | "sacrifice" | "error" | "other";

function classifyResultMirror(text: string): MirrorPlayType {
  if (text.includes("홈런")) return "homerun";
  if (text.includes("삼진")) return "strikeout";
  if (text.includes("볼넷")) return "walk";
  if (text.includes("몸에 맞는 볼")) return "hbp";
  if (text.includes("아웃")) {
    if (text.includes("희생")) return "sacrifice";
    return "out";
  }
  if (text.includes("희생")) return "sacrifice";
  if (text.includes("실책")) return "error";
  if (
    text.includes("1루타") ||
    text.includes("2루타") ||
    text.includes("3루타") ||
    text.includes("내야안타") ||
    text.includes("안타")
  ) return "hit";
  return "other";
}

interface MirrorNaverTextOption { seqno: number; text: string; type: number; }
interface MirrorNaverTextRelay { title: string; titleStyle: string; textOptions?: MirrorNaverTextOption[]; }
interface MirrorPlayEvent { batterName: string; result: string; type: MirrorPlayType; extras?: string[]; }
interface MirrorInningRelay { inning: number; half: "top" | "bottom"; teamName: string; plays: MirrorPlayEvent[]; }

function parseInningRelaysMirror(textRelays: MirrorNaverTextRelay[]): MirrorInningRelay[] {
  const chronological = [...textRelays].reverse();
  const innings: MirrorInningRelay[] = [];
  let current: MirrorInningRelay | null = null;

  for (const relay of chronological) {
    if (relay.titleStyle === "0") {
      const match = relay.title.match(/(\d+)회(초|말)\s*(.+?)\s*공격/);
      if (match) {
        current = {
          inning: parseInt(match[1]),
          half: match[2] === "초" ? "top" : "bottom",
          teamName: match[3],
          plays: [],
        };
        innings.push(current);
      }
      continue;
    }
    if (!current || !relay.textOptions) continue;

    for (const opt of relay.textOptions) {
      if (opt.type === 13 || opt.type === 23) {
        // production: batter from opt.text parts[0], not title regex
        // (대타/대주자 등 비표준 title 변종 흡수)
        const parts = opt.text.split(" : ");
        if (parts.length < 2) continue;
        const batterName = parts[0].trim();
        if (!batterName) continue;
        const resultText = parts.slice(1).join(" : ");
        current.plays.push({
          batterName,
          result: resultText,
          type: classifyResultMirror(resultText),
        });
      }
    }
  }
  return innings;
}

function combineRelayInningsNewestFirstMirror(inningRelays: MirrorNaverTextRelay[][]): MirrorNaverTextRelay[] {
  return [...inningRelays].reverse().flat();
}

// ----- T12: classifyResult — "2루타성 잡혀 아웃" must NOT be hit -----
{
  assert(
    "T12: '2루타성 타구가 잡혀 아웃' → 'out' (not 'hit')",
    classifyResultMirror("유격수 정면 직선타로 잘 맞은 타구지만 2루타성 잡혀 아웃") === "out",
  );
  assert(
    "T12: '1루타성 잡혀 아웃' → 'out'",
    classifyResultMirror("1루타성 짧은 타구 잡혀 아웃") === "out",
  );
  assert(
    "T12: '삼진 아웃' → 'strikeout' (strikeout 우선 매칭)",
    classifyResultMirror("헛스윙 삼진 아웃") === "strikeout",
  );
  assert(
    "T12: '솔로 홈런' → 'homerun'",
    classifyResultMirror("우측 담장 넘어가는 솔로 홈런") === "homerun",
  );
  assert(
    "T12: '우전 1루타' (아웃 없음) → 'hit'",
    classifyResultMirror("우전 1루타") === "hit",
  );
  assert(
    "T12: '희생플라이 아웃' → 'sacrifice'",
    classifyResultMirror("우익수 희생플라이 아웃") === "sacrifice",
  );
  assert(
    "T12: '볼넷' → 'walk'",
    classifyResultMirror("스트레이트 볼넷") === "walk",
  );
}

// ----- T13: parseInningRelays — type=13/23 없는 announcement은 play emit X -----
{
  // 투수 교체/포지션 교체 등 순수 announcement은 title이 비표준이고
  // textOptions에 type=13/23 (at-bat result)이 없다 → play 미생성.
  // textRelays come in reverse order (newest-first) as Naver returns them.
  const textRelays: MirrorNaverTextRelay[] = [
    {
      title: "3번타자 홍창기",
      titleStyle: "8",
      textOptions: [{ seqno: 2, text: "홍창기 : 우전 1루타", type: 13 }],
    },
    {
      title: "투수 교체",
      titleStyle: "2",
      textOptions: [{ seqno: 1, text: "투수 교체: 김유영 → 박명근", type: 2 }],
    },
    { title: "5회초 LG 공격", titleStyle: "0" },
  ];

  const innings = parseInningRelaysMirror(textRelays);

  assert(
    "T13: type=13/23 없는 '투수 교체' announcement은 play 미생성",
    innings.length === 1
      && innings[0].plays.length === 1
      && innings[0].plays[0].batterName === "홍창기",
    { plays: innings[0]?.plays },
  );
}

// ----- T14: gameId-change reset — SPA navigation between game pages -----
// Production: useCelebration's [gameId] useEffect clears
// seenRef/queue/primedSourcesRef/pitcherKRef + sets suppressBeforeRef to a
// finite value matching markResumeBoundary semantics. THREE guards must
// reset coherently for the new game to behave like a fresh session:
//   1. seenRef + primedSourcesRef: prevent old game's primed-source state
//      leaking forward (first batch from each source must seed baseline).
//   2. suppressBeforeRef: must be FINITE (Date.now() + RESUME_GRACE_MS).
//      Setting it to Infinity (the initial ref value) silently blocks every
//      subsequent celebration via `eventTime <= suppressBeforeRef.current`
//      — caught by 삼순 review 3차 (NO-GO #3, 2026-05-26).
// Mini-mirror models ALL of seenRef + primedSourcesRef + suppressBefore +
// FRESHNESS_THRESHOLD_MS so future suppress-guard bugs are not missed
// in self-review.
{
  const FRESHNESS_THRESHOLD_MS = 120_000;
  const RESUME_GRACE_MS = 1_000;

  const primedSources = new Set<string>();
  const seen = new Set<string>();
  let suppressBefore = Number.POSITIVE_INFINITY;

  /** Mirrors useCelebration.ts processEvents — must include ALL gating
   *  guards (source-baseline, seenRef, suppressBefore, freshness) so a
   *  miss in any one guard breaks an assertion below. */
  function simulateProcess(
    events: { id: string; source?: string; timestamp: number }[],
    nowMs: number,
  ): string[] {
    const fired: string[] = [];
    const sourcesInBatch = new Set<string>();
    for (const ev of events) sourcesInBatch.add(ev.source ?? "_unknown");
    const sourcesToBaseline: string[] = [];
    for (const src of sourcesInBatch) {
      if (!primedSources.has(src)) {
        sourcesToBaseline.push(src);
        primedSources.add(src);
      }
    }
    if (sourcesToBaseline.length > 0) {
      for (const ev of events) {
        if (sourcesToBaseline.includes(ev.source ?? "_unknown")) seen.add(ev.id);
      }
    }
    for (const ev of events) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      if (ev.timestamp <= suppressBefore) continue;
      if (nowMs - ev.timestamp > FRESHNESS_THRESHOLD_MS) continue;
      fired.push(ev.id);
    }
    return fired;
  }

  // Production: useEffect runs markResumeBoundary on mount (visibility=visible).
  function markResume(nowMs: number) {
    primedSources.clear();
    suppressBefore = nowMs + RESUME_GRACE_MS;
  }

  /** Production: useCelebration's [gameId] reset effect. MUST set
   *  suppressBefore to a FINITE value, not the initial Infinity. */
  function simulateGameIdChangeFix(nowMs: number) {
    seen.clear();
    primedSources.clear();
    suppressBefore = nowMs + RESUME_GRACE_MS;
  }

  /** Mirrors the BUG pre-fix: suppressBefore = Infinity blocks every event. */
  function simulateGameIdChangeBuggy() {
    seen.clear();
    primedSources.clear();
    suppressBefore = Number.POSITIVE_INFINITY;
  }

  const t0 = 1_000_000_000;  // arbitrary baseline ms

  // Initial mount: markResumeBoundary fires → suppressBefore becomes finite.
  markResume(t0);

  // Game A first relay batch (3 historical events at t0+100).
  simulateProcess(
    [
      { id: "gameA-at_bat_homerun-2-T-a-1", source: "relay", timestamp: t0 + 100 },
      { id: "gameA-at_bat_hit-3-B-b-1", source: "relay", timestamp: t0 + 100 },
      { id: "gameA-at_bat_walk-4-T-c-1", source: "relay", timestamp: t0 + 100 },
    ],
    t0 + 100,
  );

  // Game A new event at t0+5000 (4s past RESUME_GRACE).
  const gameANewFired = simulateProcess(
    [
      { id: "gameA-at_bat_homerun-2-T-a-1", source: "relay", timestamp: t0 + 100 },
      { id: "gameA-at_bat_homerun-5-T-d-1", source: "relay", timestamp: t0 + 5000 },  // new
    ],
    t0 + 5000,
  );
  assert(
    "T14a: game A baseline+new — exactly 1 fire (sanity, suppressBefore + freshness modeled)",
    gameANewFired.length === 1 && gameANewFired[0] === "gameA-at_bat_homerun-5-T-d-1",
    { fired: gameANewFired },
  );

  // SPA navigation: gameId changes A → B. Use the FIX (finite suppressBefore).
  simulateGameIdChangeFix(t0 + 10_000);

  // Game B first relay full-history batch at t0+10_100 — all baseline-seeded.
  const gameBFirstFired = simulateProcess(
    [
      { id: "gameB-at_bat_homerun-1-T-x-1", source: "relay", timestamp: t0 + 10_100 },
      { id: "gameB-at_bat_hit-2-B-y-1", source: "relay", timestamp: t0 + 10_100 },
      { id: "gameB-at_bat_walk-3-T-z-1", source: "relay", timestamp: t0 + 10_100 },
    ],
    t0 + 10_100,
  );
  assert(
    "T14b: SPA navigation A→B — game B first relay full-history batch 0 fires (baseline re-armed)",
    gameBFirstFired.length === 0,
    { fired: gameBFirstFired },
  );

  // Game B second batch with a NEW id at t0+15_000 (well past RESUME_GRACE)
  // MUST actually fire. With the buggy Infinity suppressBefore, every new
  // celebration on the new game would be blocked silently.
  const gameBSecondFired = simulateProcess(
    [
      { id: "gameB-at_bat_homerun-1-T-x-1", source: "relay", timestamp: t0 + 10_100 },
      { id: "gameB-at_bat_hit-2-B-y-1", source: "relay", timestamp: t0 + 10_100 },
      { id: "gameB-at_bat_walk-3-T-z-1", source: "relay", timestamp: t0 + 10_100 },
      { id: "gameB-at_bat_double-4-T-w-1", source: "relay", timestamp: t0 + 15_000 },  // new
    ],
    t0 + 15_000,
  );
  assert(
    "T14c: game B second batch with NEW id actually FIRES (suppressBefore is finite, freshness OK)",
    gameBSecondFired.length === 1 && gameBSecondFired[0] === "gameB-at_bat_double-4-T-w-1",
    { fired: gameBSecondFired },
  );

  // Negative regression: prove the buggy Infinity reset would have blocked
  // every new game B celebration silently.
  {
    const bug_primedSources = primedSources;
    const bug_seen = seen;
    void bug_primedSources;
    void bug_seen;
    simulateGameIdChangeBuggy();  // resets seen + primedSources, sets suppressBefore = Infinity

    // First batch baseline-seeded as normal.
    simulateProcess(
      [
        { id: "gameC-at_bat_homerun-1-T-x-1", source: "relay", timestamp: t0 + 20_100 },
      ],
      t0 + 20_100,
    );

    // Second batch with truly-new id at t0+25_000 — buggy version would block.
    const buggyGameCFired = simulateProcess(
      [
        { id: "gameC-at_bat_homerun-1-T-x-1", source: "relay", timestamp: t0 + 20_100 },
        { id: "gameC-at_bat_double-2-T-y-1", source: "relay", timestamp: t0 + 25_000 },  // new
      ],
      t0 + 25_000,
    );
    assert(
      "T14d: BUG REGRESSION — buggy Infinity suppressBefore reset blocks every new celebration (proves the fix matters)",
      buggyGameCFired.length === 0,
      { fired: buggyGameCFired },
    );
  }
}

// ----- T15: 대타 (pinch hitter) 3루타 — batter from opt.text, not title -----
// 2026-05-27 prod P0: 7회초 LG 대타 "문정빈" 3루타가 안타로 잘못 발화.
// 원인: title "대타 문정빈"이 `/\d+번타자\s+(.+)/` 정규식에 안 잡혀
// 전체 relay 항목 skip → BoxScore-diff fallback이 stale boxscore로 single 분류.
// fix: opt.text "X : 결과" parts[0]에서 batter 추출 → title 무관하게 emit.
{
  const textRelays: MirrorNaverTextRelay[] = [
    {
      title: "대타 문정빈",
      titleStyle: "2",  // 대타 announcement style
      textOptions: [
        { seqno: 4, text: "1구 볼", type: 1 },
        { seqno: 5, text: "문정빈 : 우익수 오른쪽 뒤 3루타", type: 23 },
        { seqno: 6, text: "1루주자 오스틴 : 홈인", type: 24 },
      ],
    },
    { title: "7회초 LG 공격", titleStyle: "0" },
  ];

  const innings = parseInningRelaysMirror(textRelays);
  const triple = innings[0]?.plays[0];

  assert(
    "T15: '대타 문정빈' title이어도 opt.text parts[0]='문정빈' 정상 추출",
    !!triple && triple.batterName === "문정빈",
    { play: triple },
  );
  assert(
    "T15: result '우익수 오른쪽 뒤 3루타' → classifyResult 'hit'",
    triple?.type === "hit",
    { type: triple?.type, result: triple?.result },
  );

  // Chain into generateRelayEvents to confirm at_bat_triple emission
  const live = mkLive({ inning: 7, isTop: true, currentBatter: "문정빈" });
  const events = generateRelayEvents(
    GAME_ID,
    [{ inning: 7, half: "top", teamName: "LG", plays: [{
      batterName: triple!.batterName,
      result: triple!.result,
      type: "hit",
    }] }],
    live,
  );

  assert(
    "T15: 대타 3루타 → at_bat_triple 이벤트 1건 (단순 at_bat_hit 아님)",
    events.length === 1 && events[0].type === "at_bat_triple",
    { events: events.map(e => ({ id: e.id, type: e.type })) },
  );
}

// ----- T16: 내야안타 (infield hit) — classifyResult must include this -----
// Production observed: 7회초 LG 구본혁 "유격수 왼쪽 내야안타"가 'other'로
// 떨어져 세레머니 미발화. classifyResult가 "1루타/2루타/3루타"만 hit으로
// 매칭하던 게 원인. fix: "내야안타", "안타" substring도 hit으로 인정 +
// classifyHit이 N루타 없으면 single fallback (BoxScore-diff와 동일 동작).
{
  assert(
    "T16: '유격수 왼쪽 내야안타' → 'hit' (not 'other')",
    classifyResultMirror("유격수 왼쪽 내야안타") === "hit",
  );
  assert(
    "T16: 'N루타 없는 안타' → 'hit' (defensive — Naver 텍스트 variance 흡수)",
    classifyResultMirror("좌익수 앞 안타") === "hit",
  );

  // Chain into generateRelayEvents to confirm at_bat_hit (single) emission
  const live = mkLive({ inning: 7, isTop: true, currentBatter: "구본혁" });
  const events = generateRelayEvents(
    GAME_ID,
    [{ inning: 7, half: "top", teamName: "LG", plays: [{
      batterName: "구본혁",
      result: "유격수 왼쪽 내야안타",
      type: "hit",
    }] }],
    live,
  );
  assert(
    "T16: 내야안타 → at_bat_hit (N루타 substring 없으므로 single fallback)",
    events.length === 1 && events[0].type === "at_bat_hit",
    { events: events.map(e => ({ id: e.id, type: e.type })) },
  );
}

// ----- T17: 대주자 substitution — type=14/24 only, no at-bat play emitted -----
// 대주자 X 들어와 도루 성공 같은 base running event는 type=14/24로 들어와
// 직전 play의 extras에 attach. 별도 play로 emit 안 됨 (at-bat 아님).
{
  const textRelays: MirrorNaverTextRelay[] = [
    {
      title: "3번타자 홍창기",
      titleStyle: "8",
      textOptions: [{ seqno: 1, text: "홍창기 : 좌익수 앞 1루타", type: 13 }],
    },
    {
      title: "대주자 박해민",
      titleStyle: "2",
      textOptions: [{ seqno: 2, text: "대주자 박해민", type: 2 }],
      // 도루는 다음 batter 등판 후 type=14/24로 들어옴, 이 item엔 없음
    },
    { title: "1회초 LG 공격", titleStyle: "0" },
  ];

  const innings = parseInningRelaysMirror(textRelays);

  assert(
    "T17: 대주자 announcement (type=13/23 없음) → 별도 play emit 안 됨, 홍창기 1루타만 1건",
    innings.length === 1
      && innings[0].plays.length === 1
      && innings[0].plays[0].batterName === "홍창기"
      && innings[0].plays[0].type === "hit",
    { plays: innings[0]?.plays },
  );
}

// ----- T18: full-history multi-inning order — repeat batter cumIdx stable -----
// /api/game-relay fetches innings 1→current, but each inning payload is
// newest-first. If those bundles are flattened as-is, parseInningRelays()
// reverses the full game into current→1회 order. Then the same batter's 5회
// 2루타 gets idx=1 and his older 1회 2루타 gets idx=2, so a later poll can
// replay the old 1회 event as a fresh relay id.
{
  const inning1NewestFirst: MirrorNaverTextRelay[] = [
    {
      title: "2번타자 박지훈",
      titleStyle: "8",
      textOptions: [{ seqno: 2, text: "박지훈 : 좌익수 왼쪽 2루타", type: 13 }],
    },
    { title: "1회말 KT 공격", titleStyle: "0" },
  ];
  const inning5NewestFirst: MirrorNaverTextRelay[] = [
    {
      title: "2번타자 박지훈",
      titleStyle: "8",
      textOptions: [{ seqno: 2, text: "박지훈 : 우익수 오른쪽 2루타", type: 13 }],
    },
    { title: "5회말 KT 공격", titleStyle: "0" },
  ];

  const innings = parseInningRelaysMirror(
    combineRelayInningsNewestFirstMirror([inning1NewestFirst, inning5NewestFirst]),
  );
  const live = mkLive({ inning: 5, isTop: false, currentBatter: "박지훈" });
  const events = generateRelayEvents(GAME_ID, innings, live);
  const ids = events.map(e => e.id);

  assert(
    "T18: full-history parse order remains 1회→5회 after route combine",
    innings.map(i => `${i.inning}-${i.half}`).join(",") === "1-bottom,5-bottom",
    { innings: innings.map(i => ({ inning: i.inning, half: i.half })) },
  );
  assert(
    "T18: same batter repeat double keeps chronological cumIdx (1회 idx=1, 5회 idx=2)",
    ids[0]?.endsWith("-1-B-박지훈-1") === true
      && ids[1]?.endsWith("-5-B-박지훈-2") === true,
    { ids },
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll relay-source celebration checks passed");
}
