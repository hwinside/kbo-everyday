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
  if (text.includes("1루타") || text.includes("2루타") || text.includes("3루타")) return "hit";
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

    const batterMatch = relay.title.match(/\d+번타자\s+(.+)/);
    if (!batterMatch) continue;  // production: skip 비표준 title
    const batterName = batterMatch[1];

    for (const opt of relay.textOptions) {
      if (opt.type === 13 || opt.type === 23) {
        const parts = opt.text.split(" : ");
        const resultText = parts.length > 1 ? parts.slice(1).join(" : ") : opt.text;
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

// ----- T13: parseInningRelays — batter title 비표준 → play emit X -----
{
  // textRelays come in reverse order (newest-first) as Naver returns them.
  // Chronologically: inning header → 비표준 title 항목 (skip) → 정상 title 항목 (emit)
  const textRelays: MirrorNaverTextRelay[] = [
    {
      title: "3번타자 홍창기",
      titleStyle: "8",
      textOptions: [{ seqno: 2, text: "홍창기 : 우전 1루타", type: 13 }],
    },
    {
      title: "대주자 박해민",
      titleStyle: "8",
      textOptions: [{ seqno: 1, text: "박해민 : 도루 성공", type: 13 }],
    },
    { title: "5회초 LG 공격", titleStyle: "0" },
  ];

  const innings = parseInningRelaysMirror(textRelays);

  assert(
    "T13: 비표준 title '대주자 박해민' textOption은 emit되지 않음",
    innings.length === 1
      && innings[0].plays.length === 1
      && innings[0].plays[0].batterName === "홍창기",
    { plays: innings[0]?.plays },
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll relay-source celebration checks passed");
}
