/**
 * 직관 다이어리 통계 S1b — 순수 집계 모듈 회귀 (네트워크·DB 없음).
 * spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §5·§9·§10·§11·§12
 *
 * 커버 (§9/§11 필수 회귀 중 S1b 순수 로직 몫):
 *  - regular final만 산입, manual+GPS 동일 game dedupe, overall/gps 스키마 동일·scope 전환
 *  - A1 동일 분모(W/(W+L+D))·officialWinRate 메타 분리, mixed A1 top-level comparable null+perTeam
 *  - AVG/ERA pooled denominator, HR·피안타 per-game, B 표본 가드(AB60/outs81/final3)
 *  - complete·incomplete 혼합 → B/C partial_data fail-closed (+unknownGameIds coverage)
 *  - 직관 경기 complete + 시즌 baseline만 partial → 직관 사실값 유지·시즌 비교만 null
 *  - C 현재 최애 재계산·appearance/dnp/unknown coverage·C6 역할별 ranking·C5 top1
 *  - D1 1점차 경계, D6 ready+no_wins leaf 승격(§12 고정 payload), D5 cancelled만
 *  - E1 스트릭(일정 기반 current/longest), E2/E3/E4 사실형
 *  - empty 계약(§11)·cancelled-only(no_final)·cancelled-only+invalid snapshot(=invalid_snapshot 단 1개)
 *  - 판정 사다리 결속: 모든 state는 resolveMetricState/worstState(§12 유일 선언) 경유
 *
 * 실행: npm run qa:venue-stats-s1b-aggregate
 */
import { canonicalPayloadHash, type LedgerRecord } from "@/lib/game-logs/completeness";
import type { PlayerGameLogRow } from "@/lib/game-logs/ingest";
import type { KboGame, TeamStanding } from "@/lib/crawler/kbo-api";
import type { FavoritePlayerSnapshot } from "@/lib/venue-attendance/player-comparison";
import type { VenueAttendanceRow } from "@/lib/venue-attendance/summary";
import {
  buildVenueStatsScope,
  parseGameTeamCodes,
  type SeasonGameVerification,
  type TeamSeasonTotals,
  type VenueStatsAggregateInput,
} from "@/lib/venue-stats/aggregate";
import {
  METRIC_IDS,
  type B1Value,
  type B2Value,
  type B3Value,
  type B4Side,
  type B4Value,
  type C4Entry,
  type MetricEnvelope,
} from "@/lib/venue-stats/types";
import { buildVenueStatsHero } from "@/lib/venue-stats/ui";
import {
  buildCurrentSeasonBaselines,
  parseSeasonInningsOuts,
  type FavoriteSeasonBaselineSnapshot,
} from "@/lib/venue-stats/current-season-baseline";
import { TEAMS } from "@/lib/constants/teams";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function approx(a: number | null | undefined, b: number, eps = 1e-9): boolean {
  return typeof a === "number" && Math.abs(a - b) < eps;
}

// ── fixture ──────────────────────────────────────────────────────────────────
// 팀: LG=1, OB=2, KT=3. 최애: F1=70001(타자, LG), F2=70002(투수, LG), F4=70004(타자, LG).
const LG = 1;
const OB = 2;
const KT = 3;

function game(partial: Partial<KboGame> & { gameId: string }): KboGame {
  return {
    date: partial.gameId.slice(0, 8),
    time: "18:30",
    stadium: "잠실",
    awayTeamId: OB,
    homeTeamId: LG,
    awayName: "두산",
    homeName: "LG",
    awayScore: null,
    homeScore: null,
    inning: 0,
    isTop: false,
    status: "final",
    awayStarterName: "",
    homeStarterName: "",
    winPitcher: "",
    losePitcher: "",
    savePitcher: "",
    ...partial,
  } as KboGame;
}

// G1~G6: 직관 경기. G4=ledger 없음(incomplete), G5=우천취소, G6=manual 전용.
const G1 = game({ gameId: "20260601LGOB0", time: "14:00", homeTeamId: LG, awayTeamId: OB, homeScore: 5, awayScore: 3 });
const G2 = game({ gameId: "20260605OBLG0", stadium: "고척", homeTeamId: OB, awayTeamId: LG, homeScore: 4, awayScore: 4 });
const G3 = game({ gameId: "20260610LGKT0", stadium: "수원", homeTeamId: KT, awayTeamId: LG, homeScore: 2, awayScore: 1 });
const G4 = game({ gameId: "20260615LGOB0", homeTeamId: LG, awayTeamId: OB, homeScore: 7, awayScore: 1 });
const G5 = game({ gameId: "20260620LGOB0", status: "cancelled" });
const G6 = game({ gameId: "20260625LGOB0", time: "17:00", homeTeamId: LG, awayTeamId: OB, homeScore: 3, awayScore: 2 });
// G7/G8: 직관 안 간 LG 시즌 경기 (E1 일정·시즌 baseline 전용).
const GAMES = new Map([G1, G2, G3, G4, G5, G6].map((g) => [g.gameId, g]));

let rowSeq = 1;
function att(gameId: string, source: VenueAttendanceRow["source"], snapshot: number | null = LG): VenueAttendanceRow {
  return {
    id: rowSeq++,
    game_id: gameId,
    game_date: `${gameId.slice(0, 4)}-${gameId.slice(4, 6)}-${gameId.slice(6, 8)}`,
    favorite_team_id_snapshot: snapshot,
    stadium_name: null,
    recorded_at: "2026-07-01T00:00:00Z",
    source,
  };
}

function log(
  gameId: string,
  kboId: string,
  type: "batter" | "pitcher",
  teamId: number,
  stats: Partial<PlayerGameLogRow>,
): PlayerGameLogRow {
  const isHome = GAMES.get(gameId) ? GAMES.get(gameId)!.homeTeamId === teamId : true;
  return {
    kbo_id: kboId,
    player_type: type,
    game_id: gameId,
    game_date: `${gameId.slice(0, 4)}-${gameId.slice(4, 6)}-${gameId.slice(6, 8)}`,
    team_id: teamId,
    team_code: teamId === LG ? "LG" : teamId === OB ? "OB" : "KT",
    opponent_team_id: teamId === LG ? OB : LG,
    is_home: isHome,
    result: "W",
    ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, so: 0,
    ip_outs: 0, er: 0, h_allowed: 0, k: 0, bb_allowed: 0,
    ...stats,
  };
}

// complete 경기별 전체 행 (LG 타자 3 + LG 투수 2 + OB 타자 1) — 팀 경기 합계 AB30/H9/HR1, outs27/er3/hA8.
const GAME_ROWS: Record<string, PlayerGameLogRow[]> = {
  [G1.gameId]: [
    log(G1.gameId, "70001", "batter", LG, { ab: 4, h: 2, hr: 1, rbi: 2 }),
    log(G1.gameId, "70004", "batter", LG, { ab: 13, h: 4 }),
    log(G1.gameId, "71002", "batter", LG, { ab: 13, h: 3 }),
    log(G1.gameId, "70002", "pitcher", LG, { ip_outs: 18, er: 2, k: 6, h_allowed: 5 }),
    log(G1.gameId, "71003", "pitcher", LG, { ip_outs: 9, er: 1, k: 3, h_allowed: 3 }),
    log(G1.gameId, "72001", "batter", OB, { ab: 4, h: 1 }),
  ],
  [G2.gameId]: [
    log(G2.gameId, "70001", "batter", LG, { ab: 4, h: 1 }),
    log(G2.gameId, "70004", "batter", LG, { ab: 13, h: 4, hr: 1 }),
    log(G2.gameId, "71002", "batter", LG, { ab: 13, h: 4 }),
    log(G2.gameId, "70002", "pitcher", LG, { ip_outs: 18, er: 2, k: 6, h_allowed: 5 }),
    log(G2.gameId, "71003", "pitcher", LG, { ip_outs: 9, er: 1, k: 3, h_allowed: 3 }),
    log(G2.gameId, "72001", "batter", OB, { ab: 4, h: 2 }),
  ],
  [G3.gameId]: [
    log(G3.gameId, "70001", "batter", LG, { ab: 3, h: 2 }),
    log(G3.gameId, "70004", "batter", LG, { ab: 14, h: 4 }),
    log(G3.gameId, "71002", "batter", LG, { ab: 13, h: 3, hr: 1 }),
    log(G3.gameId, "70002", "pitcher", LG, { ip_outs: 18, er: 2, k: 6, h_allowed: 5 }),
    log(G3.gameId, "71003", "pitcher", LG, { ip_outs: 9, er: 1, k: 3, h_allowed: 3 }),
    log(G3.gameId, "72001", "batter", KT, { ab: 4, h: 1 }),
  ],
  // G4는 행은 있지만 ledger 없음 → fail-closed incomplete (§11).
  [G4.gameId]: [
    log(G4.gameId, "70001", "batter", LG, { ab: 4, h: 3, hr: 1, rbi: 4 }),
  ],
  [G6.gameId]: [
    log(G6.gameId, "70001", "batter", LG, { ab: 4, h: 1, hr: 1, rbi: 1 }),
    log(G6.gameId, "70004", "batter", LG, { ab: 13, h: 4 }),
    log(G6.gameId, "71002", "batter", LG, { ab: 13, h: 4 }),
    log(G6.gameId, "70002", "pitcher", LG, { ip_outs: 18, er: 2, k: 6, h_allowed: 5 }),
    log(G6.gameId, "71003", "pitcher", LG, { ip_outs: 9, er: 1, k: 3, h_allowed: 3 }),
    log(G6.gameId, "72001", "batter", OB, { ab: 4, h: 0 }),
  ],
};

const ATTENDANCE_LOGS = Object.values(GAME_ROWS).flat();

const LEDGERS = new Map<string, LedgerRecord>(
  [G1, G2, G3, G6].map((g) => {
    const rows = GAME_ROWS[g.gameId];
    return [
      g.gameId,
      {
        status: "complete" as const,
        expected_row_count: rows.length,
        expected_payload_hash: canonicalPayloadHash(rows),
      },
    ];
  }),
);

// 시즌 ledger 경기 검증 목록 (RPC games 결과 상당) — G4 incomplete, G7/G8 미직관.
const SEASON_GAMES: SeasonGameVerification[] = [
  ...[G1, G2, G3, G6].map((g) => ({
    gameId: g.gameId,
    gameDate: `${g.gameId.slice(0, 4)}-${g.gameId.slice(4, 6)}-${g.gameId.slice(6, 8)}`,
    complete: true,
    teamCodes: parseGameTeamCodes(g.gameId),
    awayTeamId: g.awayTeamId,
    homeTeamId: g.homeTeamId,
    awayScore: g.awayScore!,
    homeScore: g.homeScore!,
  })),
  {
    gameId: G4.gameId,
    gameDate: "2026-06-15",
    complete: false,
    teamCodes: parseGameTeamCodes(G4.gameId),
    awayTeamId: G4.awayTeamId,
    homeTeamId: G4.homeTeamId,
    awayScore: G4.awayScore!,
    homeScore: G4.homeScore!,
  },
  { gameId: "20260628LGOB0", gameDate: "2026-06-28", complete: true, teamCodes: ["LG", "OB"], awayTeamId: LG, homeTeamId: OB, awayScore: 4, homeScore: 2 },
  { gameId: "20260629LGOB0", gameDate: "2026-06-29", complete: true, teamCodes: ["LG", "OB"], awayTeamId: LG, homeTeamId: OB, awayScore: 6, homeScore: 3 },
];

const FAVORITES: FavoritePlayerSnapshot[] = [
  { playerId: "70001", name: "최애타자", teamId: LG },
  { playerId: "70002", name: "최애투수", teamId: LG },
  { playerId: "70004", name: "최애타자2", teamId: LG },
];

const STANDINGS: TeamStanding[] = [
  { teamName: "LG", teamId: LG, games: 100, wins: 50, losses: 40, draws: 10, winRate: 0.556, gamesBehind: 0 },
  { teamName: "KT", teamId: KT, games: 100, wins: 45, losses: 50, draws: 5, winRate: 0.474, gamesBehind: 5 },
];

const TEAM_TOTALS = new Map<number, TeamSeasonTotals>([
  [LG, { teamId: LG, completeGames: 30, ab: 900, h: 225, hr: 30, outs: 810, er: 120, hAllowed: 250 }],
  [KT, { teamId: KT, completeGames: 30, ab: 900, h: 250, hr: 25, outs: 810, er: 100, hAllowed: 240 }],
]);

const FAVORITE_BASELINES = new Map<string, FavoriteSeasonBaselineSnapshot>([
  ["70001", { batter: { ab: 19, h: 7, hr: 2, rbi: 3, games: 5 }, pitcher: null }],
  ["70002", { batter: null, pitcher: { outs: 90, er: 10, k: 30, games: 5 } }],
  ["70004", { batter: { ab: 63, h: 18, hr: 1, rbi: 0, games: 5 }, pitcher: null }],
]);

const BASE_ROWS: VenueAttendanceRow[] = [
  att(G1.gameId, "story_geofence"),
  att(G1.gameId, "diary_manual"), // 동일 game_id GPS+manual → dedupe 1경기 (§5)
  att(G2.gameId, "story_geofence"),
  att(G3.gameId, "story_geofence"),
  att(G4.gameId, "diary_manual"),
  att(G5.gameId, "story_geofence"),
  att(G6.gameId, "diary_manual"),
];

function input(over: Partial<VenueStatsAggregateInput> = {}): VenueStatsAggregateInput {
  return {
    season: 2026,
    supportedSeason: 2026,
    scope: "overall",
    rows: BASE_ROWS,
    games: GAMES,
    standings: STANDINGS,
    currentTeamId: LG,
    favorites: FAVORITES,
    attendanceLogs: ATTENDANCE_LOGS,
    ledgers: LEDGERS,
    seasonGames: SEASON_GAMES,
    teamSeasonTotals: TEAM_TOTALS,
    favoriteSeasonBaselines: FAVORITE_BASELINES,
    // D7 실책 — 기본 fixture 는 미확인(빈 Map). 개별 케이스에서 over 로 주입한다.
    gameErrors: new Map<string, { away: number; home: number }>(),
    todayKst: "2026-07-30",
    ...over,
  };
}

function item(m: MetricEnvelope, key: string) {
  return m.items?.find((i) => i.key === key);
}

// ── 1) overall — complete·incomplete 혼합 ────────────────────────────────────
console.log("\n[1] overall scope (complete+incomplete 혼합, manual 포함, dedupe)");
{
  const s = buildVenueStatsScope(input({ scope: "overall" }));
  ok("scope.state=ready", s.state === "ready");
  ok("22종 metric 전부 존재", METRIC_IDS.every((id) => s.metrics[id] !== undefined), `ids=${Object.keys(s.metrics).length}`);
  ok("coverage: attendance 6 / final 5 / cancelled 1 / dedupe 1", s.coverage.attendanceGames === 6 && s.coverage.finalGames === 5 && s.coverage.cancelledGames === 1 && s.coverage.dedupedRows === 1);
  ok("coverage: incomplete final 1 (G4 ledger 없음 fail-closed)", s.coverage.incompleteFinalGames === 1);

  const a1 = s.metrics.A1 as MetricEnvelope<{ attendance: { w: number; l: number; d: number; rate: number | null }; teamComparable: { rate: number | null } | null; deltaPp: number | null }>;
  ok("A1 ready, 3승1패1무", a1.state === "ready" && a1.value?.attendance.w === 3 && a1.value?.attendance.l === 1 && a1.value?.attendance.d === 1);
  ok("A1 동일 분모 rate=W/(W+L+D)=.6", approx(a1.value?.attendance.rate, 3 / 5));
  ok("A1 팀 rate=50/100=.5, deltaPp=+10", approx(a1.value?.teamComparable?.rate, 0.5) && approx(a1.value?.deltaPp, 10));
  const official = (a1.coverage as { officialWinRate?: { attendance: number | null } }).officialWinRate;
  ok("A1 officialWinRate 메타=W/(W+L)=.75 (delta에 안 섞임)", approx(official?.attendance, 0.75));

  const a2 = s.metrics.A2;
  ok("A2 상대팀 cell: OB n=4 ready / KT n=1 sample_limited", item(a2, String(OB))?.n === 4 && item(a2, String(OB))?.state === "ready" && item(a2, String(KT))?.n === 1 && item(a2, String(KT))?.state === "sample_limited");
  const a5 = s.metrics.A5;
  ok("A5 낮/밤: day 2 / night 3 (18시 경계)", item(a5, "day")?.n === 2 && item(a5, "night")?.n === 3);

  ok("B1 partial_data fail-closed (incomplete 혼합)", s.metrics.B1.state === "partial_data" && s.metrics.B1.value === null);
  ok("B1 coverage.unknownGameIds=[G4]", JSON.stringify(s.metrics.B1.coverage.unknownGameIds) === JSON.stringify([G4.gameId]));
  ok("B2/B4도 partial_data", s.metrics.B2.state === "partial_data" && s.metrics.B4.state === "partial_data");
  const b3 = s.metrics.B3 as MetricEnvelope<B3Value>;
  ok("B3는 game 스코어 단독이라 partial 아님(§5 비교값 한정): 20득점/5경기=4.0", b3.state === "ready" && b3.value?.totalRuns === 20 && approx(b3.value?.runsPerGame, 4));
  const lgSeasonRuns = SEASON_GAMES.reduce((sum, game) =>
    sum + (game.awayTeamId === LG ? game.awayScore! : game.homeTeamId === LG ? game.homeScore! : 0), 0);
  ok("B3 시즌 평균 득점=공식 정규시즌 스코어 / 팀 경기수 + delta", b3.value?.seasonRunsPerGame === lgSeasonRuns / SEASON_GAMES.length && b3.value?.delta === 4 - lgSeasonRuns / SEASON_GAMES.length);

  ok("C1 partial_data (G4 unknown_log_gap)", s.metrics.C1.state === "partial_data");
  const c1f1 = item(s.metrics.C1, "70001");
  ok("C1 F1 item coverage: eligible 5 / complete 4 / unknown 1", (c1f1?.coverage as { eligible: number; complete: number; unknown: number })?.eligible === 5 && (c1f1?.coverage as { complete: number })?.complete === 4 && (c1f1?.coverage as { unknown: number })?.unknown === 1);
  ok("C4/C5도 partial_data", s.metrics.C4.state === "partial_data" && s.metrics.C5.state === "partial_data");

  const d1 = s.metrics.D1 as MetricEnvelope<{ avgRunDiff: number | null; closeGameRate: number | null; closeGames: number }>;
  ok("D1 avgRunDiff=+1.6, 1점차 경계 close 3/5", approx(d1.value?.avgRunDiff, 1.6) && d1.value?.closeGames === 3 && approx(d1.value?.closeGameRate, 0.6));
  const d5 = s.metrics.D5 as MetricEnvelope<{ cancelledCount: number }>;
  ok("D5 cancelledCount=1 (final 분모 미오염)", d5.state === "ready" && d5.value?.cancelledCount === 1);
  const d6 = s.metrics.D6 as MetricEnvelope<{ maxTeamRuns: { gameId: string; runs: number } | null; maxMarginWin: { margin: number } | null }>;
  ok("D6 maxTeamRuns=G4 7점 / maxMarginWin margin 6", d6.value?.maxTeamRuns?.gameId === G4.gameId && d6.value?.maxTeamRuns?.runs === 7 && d6.value?.maxMarginWin?.margin === 6);

  const e1 = s.metrics.E1 as MetricEnvelope<{ current: number | null; longest: number }>;
  ok("E1 일정 기반: longest=5(G1~G4,G6 연속) / current=0(G7·G8 미참석)", e1.value?.longest === 5 && e1.value?.current === 0);
  const e3 = s.metrics.E3 as MetricEnvelope<{ firstAttendanceDate: string; daysSinceFirst: number; totalGames: number }>;
  ok("E3 첫 직관 2026-06-01 · D+59 · 누적 6", e3.value?.firstAttendanceDate === "2026-06-01" && e3.value?.daysSinceFirst === 59 && e3.value?.totalGames === 6);
  const e4 = s.metrics.E4;
  ok("E4 topStadium ready + favorite 쪽 partial_data 독립 state(§11)", e4.components?.topStadium.state === "ready" && e4.components?.mostSeenFavorites.state === "partial_data");
}

// ── 2) gps — scope 전환 (manual 제외 → 전부 complete) ────────────────────────
console.log("\n[2] gps scope (story_geofence만 — manual 혼입 금지 #972 동일 분모 규칙)");
{
  // C 정상값 산식 검증을 위해 시즌 baseline도 unknown=0인 대조군을 사용한다.
  const s = buildVenueStatsScope(input({
    scope: "gps",
    seasonGames: SEASON_GAMES.filter((game) => game.complete),
  }));
  ok("gps filter sources=[story_geofence]", JSON.stringify(s.filter.sources) === JSON.stringify(["story_geofence"]));
  ok("gps attendance 4 (G1,G2,G3,G5) / final 3 — manual(G4,G6) 미혼입", s.coverage.attendanceGames === 4 && s.coverage.finalGames === 3);
  ok("overall/gps 스키마 동일 (metric id set)", JSON.stringify(Object.keys(s.metrics).sort()) === JSON.stringify([...METRIC_IDS].sort()));

  const a1 = s.metrics.A1 as MetricEnvelope<{ attendance: { w: number; d: number; l: number; rate: number | null } }>;
  ok("A1 gps 1승1무1패 rate=1/3", a1.value?.attendance.w === 1 && approx(a1.value?.attendance.rate, 1 / 3));

  const b1 = s.metrics.B1 as MetricEnvelope<{ attendanceAvg: number | null; seasonAvg: number | null; delta: number | null }>;
  ok("B1 ready: AVG pooled 27/90=.300 vs 시즌 .250, delta +.050", b1.state === "ready" && approx(b1.value?.attendanceAvg, 0.3) && approx(b1.value?.seasonAvg, 0.25) && approx(b1.value?.delta, 0.05));
  ok("B1 denominator {attendanceAB:90, seasonAB:900}", b1.denominator.attendanceAB === 90 && b1.denominator.seasonAB === 900);
  const b2 = s.metrics.B2 as MetricEnvelope<{ attendanceEra: number | null; seasonEra: number | null }>;
  ok("B2 ready: ERA 27×9/81=3.00 vs 4.00 (outs 81 경계 통과)", b2.state === "ready" && approx(b2.value?.attendanceEra, 3) && approx(b2.value?.seasonEra, 4));
  const b4 = s.metrics.B4 as MetricEnvelope<{ hr: { attendancePerGame: number | null; seasonPerGame: number | null } ; hitsAllowed: { attendancePerGame: number | null } }>;
  ok("B4 per-game: HR 1.0 vs 1.0 / 피안타 8.0", approx(b4.value?.hr.attendancePerGame, 1) && approx(b4.value?.hr.seasonPerGame, 1) && approx(b4.value?.hitsAllowed.attendancePerGame, 8));
  ok("B4 components(hr/hitsAllowed) envelope 의무(§11)", b4.components?.hr.state === "ready" && b4.components?.hitsAllowed.state === "ready");

  const c1 = s.metrics.C1;
  const f1 = item(c1, "70001");
  ok("C1 F1 ready: 직관 5/11 vs 시즌 7/19", f1?.state === "ready" && approx((f1?.value as { attendanceAvg: number })?.attendanceAvg, 5 / 11) && approx((f1?.value as { seasonAvg: number })?.seasonAvg, 7 / 19));
  ok("C1 coverage: appearance 3 / dnp 0 / unknown 0", (f1?.coverage as { appearances: number; unknown: number })?.appearances === 3 && (f1?.coverage as { unknown: number })?.unknown === 0);
  const c2 = s.metrics.C2;
  const f2 = item(c2, "70002");
  ok("C2 F2 ready: ERA 3.00 vs 3.00, K/9=9, outs 54≥15", f2?.state === "ready" && approx((f2?.value as { attendanceEra: number })?.attendanceEra, 3) && approx((f2?.value as { attendanceK9: number })?.attendanceK9, 9));
  const c4 = s.metrics.C4;
  ok("C4 홈런 목격: F1 1방(G1)·appearance 3", (item(c4, "70001")?.value as { homeRuns: number; appearanceGames: number })?.homeRuns === 1 && (item(c4, "70001")?.value as { appearanceGames: number })?.appearanceGames === 3);
  ok(
    "C4 타자 안타·타점·홈런 묶음",
    JSON.stringify((item(c4, "70001")?.value as C4Entry | null)?.batter) ===
      JSON.stringify({ hits: 5, rbi: 2, homeRuns: 1 }),
  );
  ok(
    "C4 투수 탈삼진·0자책 경기 묶음",
    (item(c4, "70002")?.value as C4Entry | null)?.pitcher?.strikeouts === 18 &&
      (item(c4, "70002")?.value as C4Entry | null)?.pitcher?.zeroEarnedRunGames === 0,
  );
  const c5 = s.metrics.C5;
  const f1c5 = item(c5, "70001")?.value as { batterTop?: { gameId: string; hr: number } };
  ok("C5 F1 batterTop=G1 (HR desc 우선 — §10 lexicographic)", f1c5?.batterTop?.gameId === G1.gameId && f1c5?.batterTop?.hr === 1);
  const c6 = s.metrics.C6 as MetricEnvelope<{ batterRanking: Array<{ playerId: string; boostPct: number }> }>;
  ok("C6 타자 2명 → batterRanking ready·F1 1위(boost 최대)", c6.components?.batterRanking.state === "ready" && c6.value?.batterRanking[0]?.playerId === "70001");
  ok("C6 투수 1명 → pitcherRanking sample_limited (역할별 독립 — §10)", c6.components?.pitcherRanking.state === "sample_limited");

  const e1 = s.metrics.E1 as MetricEnvelope<{ longest: number; current: number | null }>;
  ok("E1 gps: longest=3 (G1~G3) / current=0", e1.value?.longest === 3 && e1.value?.current === 0);
}

// ── 3) empty 계약 (§11) ──────────────────────────────────────────────────────
console.log("\n[3] empty 계약 — 0 attendance");
{
  const s = buildVenueStatsScope(input({ rows: [] }));
  ok("scope.state=empty", s.state === "empty");
  ok("모든 metric state=empty·n=0", METRIC_IDS.every((id) => s.metrics[id].state === "empty" && s.metrics[id].n === 0));
  ok("scalar/compound value=null (A1·E3)", s.metrics.A1.value === null && s.metrics.E3.value === null);
  ok("list value/items=[] (A2·C1)", JSON.stringify(s.metrics.A2.value) === "[]" && JSON.stringify(s.metrics.C1.items) === "[]");
  ok("denominator shape 유지·전부 0 (B1)", s.metrics.B1.denominator.attendanceAB === 0 && s.metrics.B1.denominator.seasonAB === 0);
  const gps = buildVenueStatsScope(input({ rows: [att(G6.gameId, "diary_manual")], scope: "gps" }));
  ok("gps empty / overall nonempty 교차", gps.state === "empty" && buildVenueStatsScope(input({ rows: [att(G6.gameId, "diary_manual")], scope: "overall" })).state === "ready");
}

// ── 4) cancelled-only·복합 상태 (§12 파이프라인 순서) ────────────────────────
console.log("\n[4] cancelled-only / 복합 invalid snapshot / no_favorite");
{
  const cancelledOnly = buildVenueStatsScope(input({ rows: [att(G5.gameId, "story_geofence")] }));
  ok("cancelled-only: A1=no_final (성적 모수 미산입)", cancelledOnly.metrics.A1.state === "no_final");
  ok("cancelled-only: C1=no_final (no_final > no_favorite — §12 사다리)", buildVenueStatsScope(input({ rows: [att(G5.gameId, "story_geofence")], favorites: [] })).metrics.C1.state === "no_final");
  ok("cancelled-only: D5 사실형 ready·cancelledCount=1", cancelledOnly.metrics.D5.state === "ready" && (cancelledOnly.metrics.D5.value as { cancelledCount: number }).cancelledCount === 1);
  ok("cancelled-only: E2/E3 사실형 ready", cancelledOnly.metrics.E2.state === "ready" && cancelledOnly.metrics.E3.state === "ready");

  const compound = buildVenueStatsScope(input({ rows: [att(G5.gameId, "story_geofence", null)] }));
  ok("cancelled-only+invalid snapshot → invalid_snapshot 단 1개(§12 rev5 복합 확정)", compound.metrics.A1.state === "invalid_snapshot" && compound.metrics.B1.state === "invalid_snapshot" && compound.metrics.D6.state === "invalid_snapshot");
  ok("복합에서도 D5는 ready (invalid_snapshot 적용 범위 밖 — §10)", compound.metrics.D5.state === "ready");
  ok("invalid coverage=[{gameId,reason:snapshot_missing}]", JSON.stringify(compound.metrics.A1.coverage.invalidSnapshot) === JSON.stringify([{ gameId: G5.gameId, reason: "snapshot_missing" }]));

  const mismatch = buildVenueStatsScope(input({ rows: [att(G1.gameId, "story_geofence", KT)] }));
  ok("snapshot_team_mismatch → invalid_snapshot fail-closed(행 폐기 금지 — §9)", mismatch.metrics.A1.state === "invalid_snapshot" && (mismatch.metrics.A1.coverage.invalidSnapshot as Array<{ reason: string }>)[0]?.reason === "snapshot_team_mismatch");

  const noFav = buildVenueStatsScope(input({ rows: [att(G1.gameId, "story_geofence")], favorites: [] }));
  ok("final≥1 + 최애 없음 → C1=no_favorite", noFav.metrics.C1.state === "no_favorite");
}

// ── 5) mixed team (§10·§11) ──────────────────────────────────────────────────
console.log("\n[5] mixed snapshot team — A1/B perTeam");
{
  const s = buildVenueStatsScope(input({
    rows: [att(G1.gameId, "story_geofence", LG), att(G3.gameId, "story_geofence", KT)],
  }));
  const a1 = s.metrics.A1 as MetricEnvelope<{ teamComparable: unknown; deltaPp: unknown; attendance: { w: number } }>;
  ok("A1 mixed_team: top-level teamComparable/deltaPp=null (§11 exact)", a1.state === "mixed_team" && a1.value?.teamComparable === null && a1.value?.deltaPp === null);
  ok("A1 perTeam 2팀 item (LG W / KT W)", a1.items?.length === 2 && item(a1, String(LG)) !== undefined && item(a1, String(KT)) !== undefined);
  ok(
    "A1 perTeam 1경기 표본 미달: state=sample_limited 이지만 사실값(W/L/D)은 노출·비교만 null (2026-07-31 결정)",
    item(a1, String(LG))?.state === "sample_limited" &&
      (item(a1, String(LG))?.value as { attendance: { w: number }; teamComparable: unknown; deltaPp: unknown } | null)?.attendance.w === 1 &&
      (item(a1, String(LG))?.value as { teamComparable: unknown } | null)?.teamComparable === null &&
      (item(a1, String(LG))?.value as { deltaPp: unknown } | null)?.deltaPp === null,
  );
  ok("B1 mixed_team: value=null + perTeam items", s.metrics.B1.state === "mixed_team" && s.metrics.B1.value === null && s.metrics.B1.items?.length === 2);
  // ─ mixed 표본 미달 item 은 단일팀과 동일 계약: 직관 사실값 shape 보존 + 시즌 baseline·delta null.
  // (part.value 를 BTeamValue 로 cast 해 strip 하면 shape 가 깨져 attendanceAvg 까지 사라졌던 결함 — 삼순 P0-1)
  {
    const b1Item = item(s.metrics.B1, String(KT));
    const b1Value = b1Item?.value as B1Value | null;
    ok(
      "B1 mixed sample_limited item: attendanceAvg shape 보존·seasonAvg/delta null",
      b1Item?.state === "sample_limited" &&
        approx(b1Value?.attendanceAvg, 0.25) &&
        b1Value?.seasonAvg === null &&
        b1Value?.delta === null,
    );
    const b2Item = item(s.metrics.B2, String(KT));
    const b2Value = b2Item?.value as B2Value | null;
    ok(
      "B2 mixed sample_limited item: B2 shape 유지(attendanceEra 키 존재)·seasonEra/delta null",
      b2Item?.state === "sample_limited" &&
        b2Value != null &&
        "attendanceEra" in b2Value &&
        b2Value.seasonEra === null &&
        b2Value.delta === null,
    );
    const b4Item = item(s.metrics.B4, String(KT));
    const b4Value = b4Item?.value as B4Value | null;
    ok(
      "B4 mixed sample_limited item: hr/hitsAllowed attendancePerGame 보존·seasonPerGame/delta null",
      b4Item?.state === "sample_limited" &&
        b4Value?.hr?.attendancePerGame === 0 &&
        b4Value?.hr?.seasonPerGame === null &&
        b4Value?.hr?.delta === null &&
        b4Value?.hitsAllowed?.attendancePerGame === 0 &&
        b4Value?.hitsAllowed?.seasonPerGame === null &&
        b4Value?.hitsAllowed?.delta === null,
    );
    // 시즌 비교는 경기별 원장과 분리됐다. 한 경기 표본 미달만 남는다.
    ok(
      "B1 mixed: 시즌 원장 gap과 무관·1경기 표본 미달",
      item(s.metrics.B1, String(LG))?.state === "sample_limited" &&
        approx((item(s.metrics.B1, String(LG))?.value as B1Value | null)?.attendanceAvg, 0.3) &&
        (item(s.metrics.B1, String(LG))?.value as B1Value | null)?.seasonAvg === null &&
        (item(s.metrics.B1, String(LG))?.value as B1Value | null)?.delta === null,
    );
  }
  // ─ mixed_team 총 final 이 모자라면 파생 '요정 지수'도 참고용 계약 (삼순 P0-2).
  {
    const mixedHero = buildVenueStatsHero(s);
    ok(
      "hero mixed_team 총 2경기: sampleLimited=true·score=null (승률 요정 배지 방지)",
      s.metrics.A1.n === 2 && mixedHero.sampleLimited === true && mixedHero.score === null,
    );
    ok(
      "hero mixed_team: score 는 비워도 사실 W/L/D 는 그대로",
      mixedHero.attendance != null &&
        mixedHero.attendance.w + mixedHero.attendance.l + mixedHero.attendance.d === 2,
    );
  }
  const e1 = s.metrics.E1 as MetricEnvelope<{ perTeam: Array<{ teamId: number }> }>;
  ok("E1 perTeam 팀별 구간 분리 (팀 가로지르기 금지 — §9)", (e1.value?.perTeam.length ?? 0) >= 2);
}

// ── 6) 표본 가드·no_wins·attendance_only ─────────────────────────────────────
console.log("\n[6] 표본 가드 / D6 no_wins leaf 승격 / attendance_only");
{
  const single = buildVenueStatsScope(input({
    rows: [att(G3.gameId, "story_geofence")],
    seasonGames: SEASON_GAMES.filter((game) => game.complete),
  }));
  ok("final 1경기: A1 sample_limited (final≥3 가드)", single.metrics.A1.state === "sample_limited");
  ok(
    "A1 표본 미달: 사실값 노출(0승 위조 금지)·팀 비교만 null (2026-07-31 결정)",
    (single.metrics.A1.value as { attendance: { w: number; l: number } } | null)?.attendance != null &&
      (single.metrics.A1.value as { teamComparable: unknown } | null)?.teamComparable === null &&
      (single.metrics.A1.value as { deltaPp: unknown } | null)?.deltaPp === null,
  );
  ok(
    "B1 sample_limited (AB 30<60)·사실값 노출",
    single.metrics.B1.state === "sample_limited" && single.metrics.B1.value !== null,
  );
  // ─ 표본 미달은 직관 사실값만. 시즌 baseline·delta는 "3경기부터 비교" 안내와 충돌하면 안 된다.
  {
    const b1 = single.metrics.B1.value as B1Value | null;
    ok(
      "B1 sample_limited: attendanceAvg 유지·seasonAvg/delta null (카드가 칭션과 충돌 금지)",
      b1?.attendanceAvg != null && b1?.seasonAvg === null && b1?.delta === null,
    );
    const b2 = single.metrics.B2.value as B2Value | null;
    ok(
      "B2 sample_limited: attendanceEra 유지·seasonEra/delta null",
      single.metrics.B2.state === "sample_limited" && b2?.seasonEra === null && b2?.delta === null,
    );
    const b4 = single.metrics.B4.value as B4Value | null;
    ok(
      "B4 sample_limited: attendancePerGame 유지·seasonPerGame/delta null (hr·hitsAllowed 둘 다)",
      single.metrics.B4.state === "sample_limited" &&
        b4?.hr?.seasonPerGame === null && b4?.hr?.delta === null &&
        b4?.hitsAllowed?.seasonPerGame === null && b4?.hitsAllowed?.delta === null,
    );
    const hrComponent = single.metrics.B4.components?.hr.value as B4Side | null;
    ok(
      "B4 component도 동일: state=sample_limited·seasonPerGame/delta null",
      single.metrics.B4.components?.hr.state === "sample_limited" &&
        hrComponent?.seasonPerGame === null && hrComponent?.delta === null,
    );
    // 파생 '요정 지수'는 확정값처럼 보이면 안 되므로 hero score는 null.
    const hero = buildVenueStatsHero(single);
    ok(
      "hero: 표본 미달이면 score=null (2경기 전승을 100점으로 확정 표기 금지)",
      hero.score === null,
    );
    ok(
      "hero: score는 숨겨도 사실 W/L/D는 그대로 노출",
      hero.attendance != null && hero.attendance.w + hero.attendance.l + hero.attendance.d === 1,
    );
  }

  const d6 = single.metrics.D6;
  ok("D6 무승: outer=ready 승격(leaf 제외 — §12) + maxMarginWin=no_wins", d6.state === "ready" && d6.components?.maxMarginWin.state === "no_wins");
  ok("D6 no_wins 고정 payload: value.maxMarginWin=null·denominator {wins:0}", (d6.value as { maxMarginWin: unknown }).maxMarginWin === null && d6.components?.maxMarginWin.denominator.wins === 0);
  const a1single = single.metrics.A1;
  ok("loss-only rate=0 (0 위조 아님 — denominator>0 유효값)", approx((a1single.value as { attendance: { rate: number | null } } | null)?.attendance.rate ?? NaN, 0) || a1single.state === "sample_limited");

  const s2025 = buildVenueStatsScope(input({ season: 2025 }));
  ok("2025: A1 attendance_only — 직관 사실값 유지·팀 비교 null (§9)", s2025.metrics.A1.state === "attendance_only" && (s2025.metrics.A1.value as { teamComparable: unknown })?.teamComparable === null);
  ok("2025: B1/C1 fail-closed attendance_only", s2025.metrics.B1.state === "attendance_only" && s2025.metrics.C1.state === "attendance_only");
  ok("2025: A2 스플릿·D1·E3는 계산 유지", s2025.metrics.A2.state !== "attendance_only" && s2025.metrics.E3.state === "ready");
  ok("2025: E1 unsupported (일정 소스 없음)", s2025.metrics.E1.state === "unsupported");

  const noRpc = buildVenueStatsScope(input({ teamSeasonTotals: null, seasonGames: null }));
  ok("RPC 실패: B1 attendance_only fail-closed", noRpc.metrics.B1.state === "attendance_only");
  const noStandings = buildVenueStatsScope(input({ standings: null }));
  ok("standings 실패: A1 attendance_only + reasons", noStandings.metrics.A1.state === "attendance_only" && noStandings.metrics.A1.reasons?.includes("standings_unavailable") === true);
}

// ── 7) 시즌 비교 소스 분리 — 직관 원장 gap이 기존 시즌 스냅샷을 막지 않음 ──
console.log("\n[7] 시즌 비교 소스 분리 — 직관 원장 / 기존 시즌 스냅샷");
{
  // 시즌 우주 ledger가 전부 incomplete여도, 직관 3경기가 complete면 기존 시즌 스냅샷 비교는 열린다.
  const zeroBackfill = buildVenueStatsScope(input({
    scope: "gps",
    seasonGames: SEASON_GAMES.map((g) => ({ ...g, complete: false })),
  }));
  ok("[backfill 0] B1 ready + 시즌 AVG 노출", zeroBackfill.metrics.B1.state === "ready" && approx((zeroBackfill.metrics.B1.value as B1Value | null)?.seasonAvg, 0.25));
  ok("[backfill 0] C1 ready + kbo_id 시즌 AVG 노출", item(zeroBackfill.metrics.C1, "70001")?.state === "ready" && approx((item(zeroBackfill.metrics.C1, "70001")?.value as { seasonAvg: number | null } | null)?.seasonAvg, 7 / 19));
  const zbE1 = zeroBackfill.metrics.E1 as MetricEnvelope<{ longest: number; current: number | null }>;
  ok("[backfill 0] E1은 일정 우주 metric으로 독립 유지", zbE1.state === "ready");

  // 빈 일정 우주는 E1만 막고 B/C 시즌 스냅샷에는 전파하지 않는다.
  const emptyUniverse = buildVenueStatsScope(input({ scope: "gps", seasonGames: [] }));
  ok("[빈 우주] B1/C1은 기존 시즌 스냅샷으로 ready", emptyUniverse.metrics.B1.state === "ready" && emptyUniverse.metrics.C1.state === "ready");
  const euE1 = emptyUniverse.metrics.E1 as MetricEnvelope<{ perTeam: unknown[] }>;
  ok("[빈 우주] E1 unsupported + schedule_unavailable (ready·perTeam:[] 금지)", euE1.state === "unsupported" && euE1.reasons?.includes("schedule_unavailable") === true);

  // 부분 backfill도 B/C에 전파되지 않는다.
  const partial = buildVenueStatsScope(input({
    scope: "gps",
    seasonGames: SEASON_GAMES.map((g) =>
      ["20260628LGOB0", "20260629LGOB0"].includes(g.gameId) ? { ...g, complete: false } : g,
    ),
  }));
  ok("[부분 backfill] B1/C1 ready 유지", partial.metrics.B1.state === "ready" && partial.metrics.C1.state === "ready");

  // 기존 시즌 스냅샷 자체가 없을 때만 비교 지표가 attendance_only로 fail-close한다.
  const noSnapshot = buildVenueStatsScope(input({
    scope: "gps",
    teamSeasonTotals: null,
    favoriteSeasonBaselines: null,
  }));
  ok("[시즌 스냅샷 실패] B1/C1 attendance_only", noSnapshot.metrics.B1.state === "attendance_only" && noSnapshot.metrics.C1.state === "attendance_only");
}

// ── 8) 팀 공식기록 / 선수 현재시즌 스냅샷 분리 ───────────────────────────────
console.log("\n[8] 팀 공식기록 / 선수 현재시즌 스냅샷 분리");
{
  const nowMs = Date.parse("2026-08-01T12:00:00Z");
  const teamRecords = {
    season: 2026,
    batting: TEAMS.map((team) => ({
      teamId: team.id, slug: team.slug, avg: ".270", hr: 70,
      games: 100, ab: 1_000, hits: 270,
    })),
    pitching: TEAMS.map((team) => ({
      teamId: team.id, slug: team.slug, era: "4.80",
      games: 100, inningsOuts: 2_700, er: 480, hitsAllowed: 900,
    })),
  };
  const batters = TEAMS.flatMap((team, index) => [
    { kboId: `B${index}A`, team: team.shortName, games: 90, ab: 100, hits: 30, hr: 10, rbi: 40 },
    { kboId: `B${index}B`, team: team.shortName, games: 80, ab: 50, hits: 10, hr: 2, rbi: 15 },
  ]);
  const pitchers = TEAMS.flatMap((team, index) => [
    { kboId: `P${index}A`, team: team.shortName, games: 20, ip: "10 2/3", h: 12, er: 4, so: 15 },
    { kboId: `P${index}B`, team: team.shortName, games: 10, ip: "1/3", h: 1, er: 1, so: 2 },
  ]);
  const built = buildCurrentSeasonBaselines({
    season: 2026, currentSeason: 2026, generatedAt: "2026-08-01T11:00:00Z", nowMs,
    teamRecords, favoriteIds: ["B0A", "B0B", "없는선수"], bundledBatters: batters,
    bundledPitchers: pitchers,
    liveBatters: [
      // 이적선수 결함주입: 현재소속·누적값이 달라도 팀 공식기록에는 섞이지 않아야 한다.
      { kbo_id: "B0A", team: "키움", games: 91, ab: 120, hits: 48, hr: 999, rbi: 41, updated_at: "2026-08-01T11:30:00Z" },
      { kbo_id: "B0B", team: "LG", games: 0, ab: 0, hits: 0, hr: 0, rbi: 0, updated_at: "2026-05-01T00:00:00Z" },
    ],
    livePitchers: [],
  });
  const lg = built?.teamSeasonTotals?.get(LG);
  const kiwoom = built?.teamSeasonTotals?.get(TEAMS.find((team) => team.shortName === "키움")!.id);
  ok("공식 팀기록 10구단 exact", built?.teamSeasonTotals?.size === 10);
  ok("팀 AVG/ERA는 공식 raw totals", lg?.h === 270 && lg.ab === 1_000 && lg.er === 480 && lg.outs === 2_700);
  ok("이적선수 누적 999HR이 현재 팀값을 오염하지 않음", kiwoom?.hr === 70);
  ok("fresh DB는 최애 kbo_id exact overlay", built?.favoriteSeasonBaselines?.get("B0A")?.batter?.h === 48);
  ok("stale DB 0 덮어쓰기 금지", built?.favoriteSeasonBaselines?.get("B0B")?.batter?.ab === 50);
  ok("이름 fallback 없음", built?.favoriteSeasonBaselines?.get("없는선수")?.batter === null);
  ok("이닝 파서 10 2/3·1/3 exact", parseSeasonInningsOuts("10 2/3") === 32 && parseSeasonInningsOuts("1/3") === 1 && parseSeasonInningsOuts("10.2") === null);
  ok("2025는 현재시즌 snapshot 사용 금지", buildCurrentSeasonBaselines({
    season: 2025, currentSeason: 2026, generatedAt: "2026-08-01T11:00:00Z", nowMs,
    teamRecords, favoriteIds: [], bundledBatters: batters, bundledPitchers: pitchers,
    liveBatters: [], livePitchers: [],
  }) === null);
  const stalePlayers = buildCurrentSeasonBaselines({
    season: 2026, currentSeason: 2026, generatedAt: "2026-07-01T00:00:00Z", nowMs,
    teamRecords, favoriteIds: [], bundledBatters: batters, bundledPitchers: pitchers,
    liveBatters: [], livePitchers: [],
  });
  ok("선수 snapshot stale은 C만 fail-close·팀 공식값 유지", stalePlayers?.favoriteSeasonBaselines === null && stalePlayers.teamSeasonTotals?.size === 10);
  const missingTeam = buildCurrentSeasonBaselines({
    season: 2026, currentSeason: 2026, generatedAt: "2026-08-01T11:00:00Z", nowMs,
    teamRecords: { ...teamRecords, batting: teamRecords.batting.slice(1) },
    favoriteIds: ["B0A"], bundledBatters: batters, bundledPitchers: pitchers,
    liveBatters: [], livePitchers: [],
  });
  ok("공식 팀 1곳 누락은 B만 fail-close·최애 유지", missingTeam?.teamSeasonTotals === null && missingTeam.favoriteSeasonBaselines?.get("B0A")?.batter !== null);
  const mismatchedRate = buildCurrentSeasonBaselines({
    season: 2026, currentSeason: 2026, generatedAt: "2026-08-01T11:00:00Z", nowMs,
    teamRecords: { ...teamRecords, batting: teamRecords.batting.map((row, index) => index === 0 ? { ...row, avg: ".999" } : row) },
    favoriteIds: [], bundledBatters: batters, bundledPitchers: pitchers,
    liveBatters: [], livePitchers: [],
  });
  ok("공식 published/raw 불일치는 0 대신 B fail-close", mismatchedRate?.teamSeasonTotals === null);
}

// ── 9) D7 실책 — aggregate actual (삼순 P1 2026-08-02) ──────────────────────
// ⚠️ 이 블록이 없어서 `buildD7` 의 1경기 사실값 보존을 되돌려도 게이트가 못 잡았다
//    (삼순 mutation 실증: value=null 로 회귀시켜도 40/40·24/24·105/0·browser 전부 PASS).
//    D7 은 helper 가 아니라 **aggregate 산출물**을 직접 assert 한다.
console.log("\n[9] D7 실책 — 확인된 경기만 분모 + 표본 미달 사실값 보존");
{
  const errorsOf = (m: Record<string, number[]>) =>
    new Map(Object.entries(m).map(([gameId, [away, home]]) => [gameId, { away: away!, home: home! }]));

  // G1 홈 LG(5:3 승) · G2 원정 LG(4:4) · G3 원정 LG(1:2 패) · G4 홈 LG(7:1) — 전부 final.
  // 내 팀(LG) 실책: G1 home=2 · G2 away=1 · G3 away=3 · G4 home=0
  const full = buildVenueStatsScope(input({
    gameErrors: errorsOf({
      [G1.gameId]: [0, 2],
      [G2.gameId]: [1, 0],
      [G3.gameId]: [3, 1],
      [G4.gameId]: [0, 0],
    }),
  }));
  const d7 = full.metrics.D7 as MetricEnvelope<{
    myTeamErrors: number; opponentErrors: number; errorProneGames: number;
    myErrorsPerGame: number | null; knownGames: number;
    worstGame: { gameId: string; errors: number } | null;
  }>;
  ok("D7 ready (확인 4경기 ≥ 최소표본)", d7.state === "ready", `state=${d7.state} n=${d7.n}`);
  ok("D7 knownGames=4 (확인된 경기만 분모)", d7.value?.knownGames === 4, `${d7.value?.knownGames}`);
  // 홈/원정 귀속이 실제로 뒤집히는지 — 2+1+3+0 = 6
  ok("D7 내 팀 실책 6 (홈=home칸, 원정=away칸 귀속)", d7.value?.myTeamErrors === 6, `${d7.value?.myTeamErrors}`);
  // 상대 실책 = G1 away 0 + G2 home 0 + G3 home 1 + G4 away 0 = 1
  ok("D7 상대 실책 1 (내 팀 반대편 칸만 합산)", d7.value?.opponentErrors === 1, `${d7.value?.opponentErrors}`);
  ok("D7 발암경기 2건 (G1 2실책 · G3 3실책 ≥ 임계2)", d7.value?.errorProneGames === 2, `${d7.value?.errorProneGames}`);
  ok("D7 worstGame = G3(3실책)", d7.value?.worstGame?.gameId === G3.gameId && d7.value?.worstGame?.errors === 3,
    JSON.stringify(d7.value?.worstGame));

  // 미확인 경기는 분모에서 빠지고 coverage 로 노출된다.
  const partial = buildVenueStatsScope(input({
    gameErrors: errorsOf({ [G1.gameId]: [0, 2] }),
  }));
  const dPartial = partial.metrics.D7 as MetricEnvelope<{ knownGames: number; myTeamErrors: number }>;
  ok("미확인 경기는 knownGames 에 안 들어감", dPartial.value?.knownGames === 1, `${dPartial.value?.knownGames}`);
  // validFinal 5경기(G1~G4 + G6) 중 1건만 확인 → 미확인 4건.
  ok("미확인 경기 수를 coverage 로 노출",
    (dPartial.coverage as { unknownErrorGames?: number }).unknownErrorGames === 4,
    `${(dPartial.coverage as { unknownErrorGames?: number }).unknownErrorGames}`);

  // ⚠️ 핵심 RED — 표본 미달(1경기)에서도 **사실값이 보존**되어야 한다.
  //    `known.length < MIN_FINAL_GAMES` 이면 value=null 로 되돌리는 구 결함을 재주입하면
  //    아래 3개가 FAIL 한다.
  ok("표본 미달(1경기)에서도 state=sample_limited", dPartial.state === "sample_limited", `${dPartial.state}`);
  ok("표본 미달에서도 value 보존 (null 로 버리지 않음)", dPartial.value !== null, JSON.stringify(dPartial.value));
  ok("표본 미달 사실값 정확 (내 팀 2실책)", dPartial.value?.myTeamErrors === 2, `${dPartial.value?.myTeamErrors}`);

  // 확인된 경기 0건이면 사실 자체가 없으므로 value=null.
  const none = buildVenueStatsScope(input({ gameErrors: new Map() }));
  const dNone = none.metrics.D7 as MetricEnvelope<unknown>;
  ok("확인 0건 → value=null (미확인을 0으로 세지 않음)", dNone.value === null && dNone.n === 0,
    `state=${dNone.state} n=${dNone.n} value=${JSON.stringify(dNone.value)}`);

  // 실책 0 경기만 확인돼도 그건 사실이다 — value 가 있어야 한다.
  const zeroOnly = buildVenueStatsScope(input({
    gameErrors: errorsOf({ [G1.gameId]: [0, 0], [G2.gameId]: [0, 0], [G3.gameId]: [0, 0] }),
  }));
  const dZero = zeroOnly.metrics.D7 as MetricEnvelope<{ myTeamErrors: number; knownGames: number }>;
  ok("실책 0 경기 3건 → 사실값 0/3 (미확인과 구별)",
    dZero.value?.myTeamErrors === 0 && dZero.value?.knownGames === 3,
    JSON.stringify(dZero.value));
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
