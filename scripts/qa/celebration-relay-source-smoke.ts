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

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll relay-source celebration checks passed");
}
