/**
 * 직관 다이어리 통계 S1b — v1 22종 순수 집계/산식 모듈 (네트워크·DB 없음).
 * spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §4(v1 22종)·§5(공통 정책)·§9(S1 exact)·
 *       §10(ID별 payload/판정)·§11(component/item·empty)·§12(state 단일 사다리·runtime completeness)
 *
 * 판정 사다리/파이프라인은 venue-stats/state.ts(§12 유일 선언)에서 import만 한다.
 * 완전성 판정은 행 집계 heuristic 금지 — verifyLedgerCompleteness(ledger + actual rows)만 사용하고
 * ledger 없는 경기는 fail-closed incomplete다 (§11).
 */
import type { KboGame, TeamStanding } from "@/lib/crawler/kbo-api";
import { verifyLedgerCompleteness, type LedgerRecord } from "@/lib/game-logs/completeness";
import { TEAM_ID_TO_CODE, type PlayerGameLogRow } from "@/lib/game-logs/ingest";
import type { FavoritePlayerSnapshot } from "@/lib/venue-attendance/player-comparison";
import type { VenueAttendanceRow } from "@/lib/venue-attendance/summary";
import {
  resolveMetricState,
  worstState,
  type MetricState,
  type MetricStateInput,
} from "@/lib/venue-stats/state";
import { computeExcessPerformance } from "@/lib/venue-stats/expected";
import type {
  A1Value,
  AttendanceExcess,
  A2Cell,
  A3Cell,
  A4Cell,
  A5Cell,
  A6Cell,
  B1Value,
  B2Value,
  B3Value,
  B4Side,
  B4Value,
  C1Entry,
  C2Entry,
  C4Entry,
  C5Entry,
  C6Value,
  ComponentEnvelope,
  D1Value,
  D5Value,
  D7Value,
  D6Value,
  E1PerTeam,
  E1Value,
  E2Value,
  E3Value,
  E4Value,
  FavoriteCoverage,
  InvalidSnapshotEntry,
  ItemEnvelope,
  MetricEnvelope,
  MetricId,
  ScopeName,
  VenueStatsScopePayload,
  WinLossDraw,
} from "@/lib/venue-stats/types";

// ── §5 표본 가드 상수 ─────────────────────────────────────────────────────────
// 승률/스플릿/팀 경기당 지표 표본 가드. 순수 leaf 모듈(state.ts)이 SSOT —
// 클라이언트 번들이 node 전용 의존을 끌지 않도록 여기서는 재수출만 한다.
import { MIN_FINAL_GAMES } from "@/lib/venue-stats/state";
import { ERROR_PRONE_MIN } from "@/lib/venue-stats/ui";
import type { FavoriteSeasonBaselineSnapshot } from "@/lib/venue-stats/current-season-baseline";

export { MIN_FINAL_GAMES };
export const MIN_TEAM_AB = 60; // B1
export const MIN_TEAM_OUTS = 81; // B2
export const MIN_FAVORITE_AB = 10; // C1
export const MIN_FAVORITE_OUTS = 15; // C2

/** 팀 부스트 시즌 집계 (S1b RPC venue_stats_season_team_aggregates 결과 — complete 검증 경기만). */
export interface TeamSeasonTotals {
  teamId: number;
  completeGames: number;
  ab: number;
  h: number;
  hr: number;
  outs: number;
  er: number;
  hAllowed: number;
}

/**
 * 정규시즌 final 전체 경기 우주 + ledger LEFT JOIN runtime 검증 결과
 * (E1 일정·B/C 시즌 baseline coverage 공용). ledger 없는 우주 경기는 complete=false로
 * 포함된다 — 우주에서 누락되면 안 된다(§11, 삼순 리뷰 P0).
 */
export interface SeasonGameVerification {
  gameId: string;
  gameDate: string;
  complete: boolean;
  /**
   * 낮 경기(시작 18:00 KST 미만) 여부. 시간 정보가 없으면 undefined.
   * 삼순 2026-08-02: 낮경기 태그는 "단순 횟수가 아니라 낮 경기 **기회 대비** 참석 비율"이어야 하므로
   * 팀 시즌 일정의 낮 경기 비중을 알아야 한다.
   */
  isDayGame?: boolean;
  /** game_id에서 파싱한 참가팀 코드 2개 (parseGameTeamCodes). 파싱 실패 시 []. */
  teamCodes: string[];
  /** 공식 정규시즌 final 스코어. 구버전/불완전 소스는 undefined로 fail-close. */
  awayTeamId?: number;
  homeTeamId?: number;
  awayScore?: number;
  homeScore?: number;
}

export interface VenueStatsAggregateInput {
  season: number;
  /** player_game_logs·standings 비교 지원 시즌 (§9 supportedSeason=2026). */
  supportedSeason: number;
  scope: ScopeName;
  rows: VenueAttendanceRow[];
  /** 정규시즌(srId="0") 조회 결과. 없는 game_id는 game_unavailable (§10 snapshot 검증). */
  games: ReadonlyMap<string, KboGame>;
  /** fetchStandings 결과. null=조회 실패 → A1 팀비교 attendance_only fail-closed. */
  standings: TeamStanding[] | null;
  /** 현재 응원팀 (profiles.team_id) — E1 current 전용. */
  currentTeamId: number | null;
  /** 현재 최애선수 (요청 시점 재계산, §9). */
  favorites: FavoritePlayerSnapshot[];
  /** 직관 game_id 전체의 player_game_logs 행 (완전성 hash 검증 + B/C 집계 공용). */
  attendanceLogs: PlayerGameLogRow[];
  /** 직관 game_id별 ledger. 없는 경기는 incomplete (§11 fail-closed). */
  ledgers: ReadonlyMap<string, LedgerRecord>;
  /** 시즌 ledger 경기 검증 목록. null=RPC 실패/비지원 시즌. */
  seasonGames: SeasonGameVerification[] | null;
  /** 팀별 시즌 집계. null=RPC 실패/비지원 시즌. */
  teamSeasonTotals: ReadonlyMap<number, TeamSeasonTotals> | null;
  /** 기존 현재시즌 선수 스냅샷의 kbo_id exact baseline. null=소스 실패/비지원 시즌. */
  favoriteSeasonBaselines: ReadonlyMap<string, FavoriteSeasonBaselineSnapshot> | null;
  /**
   * 직관 경기의 팀별 실책(E). linescore 기반이라 `player_game_logs` 와 무관하다.
   * **키 부재 = 미확인**(0 아님) — 조회 실패를 "실책 없음"으로 승격시키지 않는다.
   */
  gameErrors: ReadonlyMap<string, { away: number; home: number }>;
  /** KST 오늘 (YYYY-MM-DD) — E3 daysSinceFirst. */
  todayKst: string;
}

/** game_id(YYYYMMDD+away2+home2+…)에서 참가팀 코드 2개 파싱. 형식 밖이면 []. */
export function parseGameTeamCodes(gameId: string): string[] {
  const codes = new Set(Object.values(TEAM_ID_TO_CODE));
  const a = gameId.slice(8, 10);
  const b = gameId.slice(10, 12);
  return codes.has(a) && codes.has(b) ? [a, b] : [];
}

// ── 내부 분류 ────────────────────────────────────────────────────────────────

interface ScopeGame {
  gameId: string;
  gameDate: string;
  source: VenueAttendanceRow["source"];
  snapshotTeamId: number | null;
  game: KboGame | null;
  stadium: string | null;
  snapshotIssue: InvalidSnapshotEntry["reason"] | null;
  isFinal: boolean;
  isCancelled: boolean;
  /** final + snapshot 유효일 때만. */
  myScore: number | null;
  oppScore: number | null;
  result: "W" | "L" | "D" | null;
  isHome: boolean | null;
  opponentTeamId: number | null;
  /** §11 runtime completeness (final만 의미). */
  complete: boolean;
}

interface Classified {
  all: ScopeGame[];
  /** final + snapshot 유효 (성적 모수, §5). */
  validFinal: ScopeGame[];
  invalidSnapshot: InvalidSnapshotEntry[];
  snapshotTeams: number[];
  dedupedRows: number;
}

function dedupeRows(rows: VenueAttendanceRow[], scope: ScopeName): {
  rows: VenueAttendanceRow[];
  dedupedRows: number;
} {
  const filtered =
    scope === "gps" ? rows.filter((r) => r.source === "story_geofence") : rows;
  const byGame = new Map<string, VenueAttendanceRow>();
  let deduped = 0;
  for (const row of filtered) {
    const prev = byGame.get(row.game_id);
    if (!prev) {
      byGame.set(row.game_id, row);
      continue;
    }
    deduped += 1;
    // 같은 game_id 중복은 1경기 dedupe — GPS 인증이 수동보다 우선 (§5).
    if (prev.source !== "story_geofence" && row.source === "story_geofence") {
      byGame.set(row.game_id, row);
    }
  }
  return { rows: [...byGame.values()], dedupedRows: deduped };
}

function classify(input: VenueStatsAggregateInput): Classified {
  const { rows, dedupedRows } = dedupeRows(input.rows, input.scope);
  const logsByGame = new Map<string, PlayerGameLogRow[]>();
  for (const log of input.attendanceLogs) {
    const list = logsByGame.get(log.game_id) ?? [];
    list.push(log);
    logsByGame.set(log.game_id, list);
  }

  const all: ScopeGame[] = [];
  const invalidSnapshot: InvalidSnapshotEntry[] = [];
  const teams = new Set<number>();

  for (const row of rows) {
    const game = input.games.get(row.game_id) ?? null;
    let issue: InvalidSnapshotEntry["reason"] | null = null;
    if (row.favorite_team_id_snapshot == null) issue = "snapshot_missing";
    else if (!game) issue = "game_unavailable";
    else if (
      game.awayTeamId !== row.favorite_team_id_snapshot &&
      game.homeTeamId !== row.favorite_team_id_snapshot
    ) {
      issue = "snapshot_team_mismatch";
    }
    if (issue) invalidSnapshot.push({ gameId: row.game_id, reason: issue });

    const isFinal = game?.status === "final";
    let myScore: number | null = null;
    let oppScore: number | null = null;
    let result: "W" | "L" | "D" | null = null;
    let isHome: boolean | null = null;
    let opponentTeamId: number | null = null;
    if (!issue && game && isFinal && game.awayScore != null && game.homeScore != null) {
      isHome = game.homeTeamId === row.favorite_team_id_snapshot;
      myScore = isHome ? game.homeScore : game.awayScore;
      oppScore = isHome ? game.awayScore : game.homeScore;
      opponentTeamId = isHome ? game.awayTeamId : game.homeTeamId;
      result = myScore > oppScore ? "W" : myScore < oppScore ? "L" : "D";
      teams.add(row.favorite_team_id_snapshot as number);
    }

    const verify = verifyLedgerCompleteness(
      input.ledgers.get(row.game_id) ?? null,
      logsByGame.get(row.game_id) ?? [],
    );

    all.push({
      gameId: row.game_id,
      gameDate: row.game_date,
      source: row.source,
      snapshotTeamId: row.favorite_team_id_snapshot,
      game,
      stadium: game?.stadium ?? row.stadium_name,
      snapshotIssue: issue,
      isFinal,
      isCancelled: game?.status === "cancelled",
      myScore,
      oppScore,
      result,
      isHome,
      opponentTeamId,
      complete: verify.complete,
    });
  }

  return {
    all,
    validFinal: all.filter((g) => g.isFinal && !g.snapshotIssue && g.result !== null),
    invalidSnapshot,
    snapshotTeams: [...teams],
    dedupedRows,
  };
}

// ── 공통 산식 helpers ────────────────────────────────────────────────────────

function wld(games: ScopeGame[]): WinLossDraw {
  let w = 0;
  let l = 0;
  let d = 0;
  for (const g of games) {
    if (g.result === "W") w += 1;
    else if (g.result === "L") l += 1;
    else if (g.result === "D") d += 1;
  }
  const total = w + l + d;
  return { w, l, d, rate: total > 0 ? w / total : null };
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

/** AVG=ΣH/ΣAB (§9 pooled denominator). */
function pooledAvg(h: number, ab: number): number | null {
  return ratio(h, ab);
}

/** ERA=27×ΣER/Σouts (§9). */
function pooledEra(er: number, outs: number): number | null {
  return outs > 0 ? (27 * er) / outs : null;
}

/** K/9=27×ΣK/Σouts (§10 C2). */
function pooledK9(k: number, outs: number): number | null {
  return outs > 0 ? (27 * k) / outs : null;
}

/** KST game_date(YYYY-MM-DD)의 요일 0(일)~6(토) — date-only 값이라 타임존 무관. */
function kstWeekday(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

/** §10 A5 — KboGame.time("18:30") 시작 18시 미만=day. 파싱 실패는 night로 보수 분류하지 않고 제외. */
function dayNightOf(game: KboGame | null): "day" | "night" | null {
  const hour = Number(game?.time?.split(":")[0]);
  if (!Number.isInteger(hour)) return null;
  return hour < 18 ? "day" : "night";
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

// ── envelope builder ─────────────────────────────────────────────────────────

const LIST_VALUE_IDS = new Set<MetricId>(["A2", "A3", "A4", "A5", "A6", "C1", "C2", "C4", "C5"]);

const EMPTY_DENOMINATORS: Record<MetricId, Record<string, number>> = {
  A1: { attendanceFinalGames: 0, teamSeasonGames: 0 },
  A2: { finalGames: 0 },
  A3: { finalGames: 0 },
  A4: { finalGames: 0 },
  A5: { finalGames: 0 },
  A6: { finalGames: 0 },
  B1: { attendanceAB: 0, seasonAB: 0 },
  B2: { attendanceOuts: 0, seasonOuts: 0 },
  B3: { finalGames: 0 },
  B4: { attendanceGames: 0, seasonGames: 0 },
  C1: { eligibleAttendanceGames: 0 },
  C2: { eligibleAttendanceGames: 0 },
  C4: { eligibleAttendanceGames: 0 },
  C5: { eligibleAttendanceGames: 0 },
  C6: { eligibleAttendanceGames: 0 },
  D1: { finalGames: 0 },
  D5: { attendanceGames: 0 },
  D6: { finalGames: 0 },
  D7: { knownErrorGames: 0 },
  E1: { eligibleTeamFinalGames: 0 },
  E2: { activeMonths: 0 },
  E3: { attendanceGames: 0 },
  E4: { attendanceGames: 0 },
};

/** §11 empty contract — 숫자 위조 없이 shape 유지, list value/items=[], scalar/compound value=null. */
function emptyMetric(id: MetricId, state: MetricState): MetricEnvelope {
  const envelope: MetricEnvelope = {
    id,
    state,
    value: LIST_VALUE_IDS.has(id) ? [] : null,
    n: 0,
    denominator: { ...EMPTY_DENOMINATORS[id] },
    coverage: {},
  };
  if (LIST_VALUE_IDS.has(id) || id === "A1") envelope.items = [];
  return envelope;
}

// ── metric 구현 ──────────────────────────────────────────────────────────────

interface Ctx {
  input: VenueStatsAggregateInput;
  c: Classified;
  seasonComparable: boolean;
  logsByGame: Map<string, PlayerGameLogRow[]>;
}

/**
 * §11 시즌 우주 가드 — 정규 final 전체 경기 우주가 실제로 존재해야 시즌 비교/일정을 연다.
 * null(소스 실패)뿐 아니라 빈 우주도 fail-closed — 빈/부분 우주로 B/C·E1이 ready·null로
 * false-green 되는 것을 막는다(삼순 리뷰 P0 보완 기준 2).
 */
function seasonUniverseAvailable(ctx: Ctx): boolean {
  return ctx.input.seasonGames !== null && ctx.input.seasonGames.length > 0;
}

function pipeline(ctx: Ctx, over: Partial<MetricStateInput>): MetricState {
  return resolveMetricState({
    seasonSupported: true,
    attendanceGames: ctx.c.all.length,
    finalGames: ctx.c.validFinal.length,
    ...over,
  });
}

function standingOf(ctx: Ctx, teamId: number): TeamStanding | null {
  return ctx.input.standings?.find((s) => s.teamId === teamId) ?? null;
}

// A1 ─ 승률 요정 지수
/**
 * pregame 기대치 대비 초과성과 — 요정 지수의 본체.
 * 시즌 우주(seasonGames)가 없거나 한 경기라도 기대치 산출 불가면 null(지수 전체 fail-close).
 */
function computeAttendanceExcess(ctx: Ctx, games: ScopeGame[]): AttendanceExcess | null {
  const seasonGames = ctx.input.seasonGames;
  if (seasonGames === null || games.length === 0) return null;
  const excesses = computeExcessPerformance(
    seasonGames,
    games.map((g) => ({
      gameId: g.gameId,
      gameDate: g.gameDate,
      myTeamId: g.snapshotTeamId,
      opponentTeamId: g.opponentTeamId,
      isHome: g.isHome,
      result: g.result,
      myScore: g.myScore,
      oppScore: g.oppScore,
    })),
  );
  if (excesses === null) return null;
  const n = excesses.length;
  return {
    winExcess: excesses.reduce((sum, e) => sum + e.winExcess, 0) / n,
    marginExcess: excesses.reduce((sum, e) => sum + e.marginExcess, 0) / n,
    games: n,
  };
}

function buildA1(ctx: Ctx): MetricEnvelope<A1Value> {
  const { c } = ctx;
  const state = pipeline(ctx, {
    invalidSnapshotGames: c.invalidSnapshot.length,
    mixedTeamApplies: true,
    snapshotTeamCount: c.snapshotTeams.length,
    comparisonSourceSupported: ctx.seasonComparable && ctx.input.standings !== null,
    sampleMet: c.validFinal.length >= MIN_FINAL_GAMES,
  });
  const attendance = wld(c.validFinal);
  const envelope: MetricEnvelope<A1Value> = {
    id: "A1",
    state,
    value: null,
    n: c.validFinal.length,
    denominator: { attendanceFinalGames: c.validFinal.length, teamSeasonGames: 0 },
    coverage: { invalidSnapshot: c.invalidSnapshot },
    items: [],
  };
  if (state === "empty" || state === "invalid_snapshot" || state === "no_final") return envelope;

  if (state === "mixed_team") {
    // §11 A1 mixed exact: value={attendance,teamComparable:null,deltaPp:null}; items=perTeam[].
    // 초과성과는 팀이 섞여도 경기별 pregame 기대치 기준이라 전체 합산이 성립한다.
    envelope.value = {
      attendance,
      teamComparable: null,
      deltaPp: null,
      excess: computeAttendanceExcess(ctx, c.validFinal),
    };
    envelope.items = c.snapshotTeams.map((teamId) => {
      const teamGames = c.validFinal.filter((g) => g.snapshotTeamId === teamId);
      const teamAttendance = wld(teamGames);
      const standing = standingOf(ctx, teamId);
      const seasonRate =
        standing && ctx.seasonComparable
          ? ratio(standing.wins, standing.wins + standing.losses + standing.draws)
          : null;
      const comparable =
        standing && ctx.seasonComparable
          ? { teamId, w: standing.wins, l: standing.losses, d: standing.draws, rate: seasonRate }
          : null;
      const deltaPp =
        teamAttendance.rate !== null && seasonRate !== null
          ? (teamAttendance.rate - seasonRate) * 100
          : null;
      const itemState = comparable
        ? teamGames.length >= MIN_FINAL_GAMES
          ? "ready"
          : "sample_limited"
        : "attendance_only";
      // §5 표본 미달이어도 직관 사실값(W/L/D·승률)은 그대로 노출하고 state 배지로만 경고한다
      // (값을 숨기면 실제 기록이 0승 0패로 보여 더 나쁜 오정보 — 2026-07-31 하린아빠 결정).
      // 비교(teamComparable·deltaPp)는 ready에서만 제공해 fail-closed 계약을 유지한다.
      return {
        key: String(teamId),
        state: itemState as MetricState,
        value:
          itemState === "ready"
            ? { attendance: teamAttendance, teamComparable: comparable, deltaPp }
            : itemState === "sample_limited"
              ? { attendance: teamAttendance, teamComparable: null, deltaPp: null }
              : null,
        n: teamGames.length,
        denominator: {
          attendanceFinalGames: teamGames.length,
          teamSeasonGames: standing ? standing.wins + standing.losses + standing.draws : 0,
        },
      } satisfies ItemEnvelope<A1Value>;
    });
    return envelope;
  }

  const teamId = c.snapshotTeams[0];
  const standing = teamId != null ? standingOf(ctx, teamId) : null;
  if (state === "attendance_only" || !standing) {
    // §9 attendance_only — A1 팀 비교만 fail-closed, 직관 사실값은 유지.
    envelope.state = "attendance_only";
    // 시즌 비교 소스가 없으면 기대치도 없다 — 요정 지수는 미산출(삼순 P0).
    envelope.value = { attendance, teamComparable: null, deltaPp: null, excess: null };
    envelope.reasons = ctx.seasonComparable ? ["standings_unavailable"] : ["season_not_supported"];
    envelope.coverage.officialWinRate = {
      attendance: ratio(attendance.w, attendance.w + attendance.l),
      team: null,
    };
    return envelope;
  }
  if (state === "sample_limited") {
    // 표본 미달 — 직관 사실값은 유지하고 팀 비교만 fail-closed (위 mixed 항과 동일 계약).
    envelope.value = { attendance, teamComparable: null, deltaPp: null, excess: null };
    return envelope;
  }

  const teamSeasonGames = standing.wins + standing.losses + standing.draws;
  const teamRate = ratio(standing.wins, teamSeasonGames);
  envelope.denominator.teamSeasonGames = teamSeasonGames;
  envelope.value = {
    attendance,
    teamComparable: {
      teamId: standing.teamId,
      w: standing.wins,
      l: standing.losses,
      d: standing.draws,
      rate: teamRate,
    },
    deltaPp:
      attendance.rate !== null && teamRate !== null
        ? (attendance.rate - teamRate) * 100
        : null,
    excess: computeAttendanceExcess(ctx, c.validFinal),
  };
  // §9 — KBO 공식 승률 W/(W+L)은 메타데이터로만 (A1 delta에 섞지 않는다).
  envelope.coverage.officialWinRate = {
    attendance: ratio(attendance.w, attendance.w + attendance.l),
    team: standing.winRate,
  };
  return envelope;
}

/**
 * A5 에 "낮 경기 기회 대비 참석" 근거를 붙인다.
 *
 * 하린아빠 2026-08-02: "야간경기가 대부분인데 야간경기 체질은 애매해.
 * 차라리 낮 경기를 유독 많이 보는 사람에게 별칭을 주는 게 자연스러움".
 * 삼순: "단순 횟수가 아니라 낮 경기 **기회 대비 참석 비율**로 판단해야 합니다."
 *
 * 그래서 응원팀 시즌 일정의 낮 경기 비중(기회)과 내 직관의 낮 경기 비중을 함께 싣는다.
 * 시즌 우주나 시간 정보가 없으면 근거를 붙이지 않는다(태그도 안 생김 — 추정 금지).
 */
function withDayGameOpportunity(
  ctx: Ctx,
  envelope: MetricEnvelope<A5Cell[]>,
): MetricEnvelope<A5Cell[]> {
  const { c } = ctx;
  const seasonGames = ctx.input.seasonGames;
  if (seasonGames === null || c.snapshotTeams.length === 0) return envelope;

  // 응원팀(들)이 참가한 정규시즌 경기 중 낮 경기 비중 = "기회".
  const teamCodes = new Set(
    c.snapshotTeams.map((teamId) => TEAM_ID_TO_CODE[teamId]).filter(Boolean),
  );
  let seasonDayGames = 0;
  let seasonTotal = 0;
  for (const game of seasonGames) {
    if (game.isDayGame === undefined) continue;
    if (!game.teamCodes.some((code) => teamCodes.has(code))) continue;
    seasonTotal += 1;
    if (game.isDayGame) seasonDayGames += 1;
  }
  if (seasonTotal === 0) return envelope;

  const attendanceWithTime = c.validFinal.filter((g) => dayNightOf(g.game) !== null);
  const attendanceDayGames = attendanceWithTime.filter(
    (g) => dayNightOf(g.game) === "day",
  ).length;
  return {
    ...envelope,
    coverage: {
      ...envelope.coverage,
      dayGameOpportunity: {
        attendanceDayGames,
        attendanceTotal: attendanceWithTime.length,
        seasonDayGames,
        seasonTotal,
      },
    },
  };
}

// A2~A6 ─ 스플릿 (cell마다 n/state 별도 — §10)
function buildSplit<T extends WinLossDraw>(
  ctx: Ctx,
  id: MetricId,
  keyOf: (g: ScopeGame) => string | null,
  cellOf: (key: string, agg: WinLossDraw) => T,
): MetricEnvelope<T[]> {
  const { c } = ctx;
  const state = pipeline(ctx, {
    invalidSnapshotGames: c.invalidSnapshot.length,
    sampleMet: c.validFinal.length >= MIN_FINAL_GAMES,
  });
  const envelope: MetricEnvelope<T[]> = {
    id,
    state,
    value: [],
    n: c.validFinal.length,
    denominator: { finalGames: c.validFinal.length },
    coverage: { invalidSnapshot: c.invalidSnapshot },
    items: [],
  };
  if (state === "empty" || state === "invalid_snapshot" || state === "no_final") return envelope;

  const groups = new Map<string, ScopeGame[]>();
  for (const g of c.validFinal) {
    const key = keyOf(g);
    if (key === null) continue;
    const list = groups.get(key) ?? [];
    list.push(g);
    groups.set(key, list);
  }
  const keys = [...groups.keys()].sort();
  // top-level value 는 표본 충족 cell 만(대표값 계약 유지). 미달 cell 은 item 으로 사실값+배지 노출.
  envelope.value = keys
    .filter((key) => groups.get(key)!.length >= MIN_FINAL_GAMES)
    .map((key) => cellOf(key, wld(groups.get(key)!)));
  envelope.items = keys.map((key) => {
    const games = groups.get(key)!;
    const itemState = games.length >= MIN_FINAL_GAMES ? "ready" : "sample_limited";
    return {
      key,
      state: itemState as MetricState,
      // 표본 미달 cell 도 승·패·무 사실값을 노출하고 state 배지로 경고한다.
      value: cellOf(key, wld(games)),
      n: games.length,
      denominator: { finalGames: games.length },
    };
  });
  return envelope;
}

// B ─ 팀 부스트
interface TeamAttendanceTotals {
  completeFinalGames: number;
  ab: number;
  h: number;
  hr: number;
  outs: number;
  er: number;
  hAllowed: number;
}

function teamAttendanceTotals(ctx: Ctx, teamId: number, games: ScopeGame[]): TeamAttendanceTotals {
  const totals: TeamAttendanceTotals = {
    completeFinalGames: 0,
    ab: 0,
    h: 0,
    hr: 0,
    outs: 0,
    er: 0,
    hAllowed: 0,
  };
  for (const g of games) {
    if (!g.complete) continue;
    totals.completeFinalGames += 1;
    for (const row of ctx.logsByGame.get(g.gameId) ?? []) {
      if (row.team_id !== teamId) continue;
      if (row.player_type === "batter") {
        totals.ab += row.ab;
        totals.h += row.h;
        totals.hr += row.hr;
      } else {
        totals.outs += row.ip_outs;
        totals.er += row.er;
        totals.hAllowed += row.h_allowed;
      }
    }
  }
  return totals;
}

interface BTeamComputed {
  b1: { value: B1Value; sampleMet: boolean; denominator: Record<string, number> };
  b2: { value: B2Value; sampleMet: boolean; denominator: Record<string, number> };
  b3: { value: B3Value; sampleMet: boolean; denominator: Record<string, number> };
  b4: {
    value: B4Value;
    sampleMet: boolean;
    denominator: Record<string, number>;
    components: Record<string, ComponentEnvelope>;
  };
  unknownGames: number;
  finalGames: number;
}

/**
 * 표본 미달(sample_limited) B 지표는 직관 사실값만 남기고 시즌 baseline·delta를 fail-closed 한다.
 * "3경기부터 팀 시즌 비교를 보여드려요" 안내문과 카드가 충돌하면 안 된다 (2026-07-31 삼순 리뷰).
 */
function stripSeasonBaseline(id: "B1" | "B2" | "B3" | "B4", value: unknown): unknown {
  if (value == null) return value;
  if (id === "B1") {
    const v = value as B1Value;
    return { attendanceAvg: v.attendanceAvg, seasonAvg: null, delta: null } satisfies B1Value;
  }
  if (id === "B2") {
    const v = value as B2Value;
    return { attendanceEra: v.attendanceEra, seasonEra: null, delta: null } satisfies B2Value;
  }
  if (id === "B3") {
    const v = value as B3Value;
    return {
      runsPerGame: v.runsPerGame,
      seasonRunsPerGame: null,
      delta: null,
      totalRuns: v.totalRuns,
    } satisfies B3Value;
  }
  const v = value as B4Value;
  const strip = (side: B4Side | null): B4Side | null =>
    side == null ? null : { attendancePerGame: side.attendancePerGame, seasonPerGame: null, delta: null };
  return { hr: strip(v.hr), hitsAllowed: strip(v.hitsAllowed) } satisfies B4Value;
}

function computeBForTeam(ctx: Ctx, teamId: number, games: ScopeGame[]): BTeamComputed {
  const att = teamAttendanceTotals(ctx, teamId, games);
  const season = ctx.input.teamSeasonTotals?.get(teamId) ?? null;
  // 시즌 baseline은 기존 현재시즌 스냅샷이므로 경기별 원장 gap과 무관하다.
  const unknownGames = games.filter((g) => !g.complete).length;

  const attendanceAvg = pooledAvg(att.h, att.ab);
  const seasonAvg = season ? pooledAvg(season.h, season.ab) : null;
  const attendanceEra = pooledEra(att.er, att.outs);
  const seasonEra = season ? pooledEra(season.er, season.outs) : null;

  const totalRuns = games.reduce((sum, g) => sum + (g.myScore ?? 0), 0);
  const seasonScoreGames = ctx.input.seasonGames?.filter(
    (game) => game.awayTeamId === teamId || game.homeTeamId === teamId,
  ) ?? [];
  const seasonScoringComplete =
    seasonScoreGames.length > 0 &&
    seasonScoreGames.every((game) =>
      Number.isInteger(game.awayTeamId) && Number.isInteger(game.homeTeamId) &&
      Number.isInteger(game.awayScore) && Number.isInteger(game.homeScore) &&
      (game.awayScore ?? -1) >= 0 && (game.homeScore ?? -1) >= 0,
    );
  const seasonTotalRuns = seasonScoringComplete
    ? seasonScoreGames.reduce(
        (sum, game) => sum + (game.awayTeamId === teamId ? game.awayScore! : game.homeScore!),
        0,
      )
    : null;
  const seasonRunsPerGame = seasonTotalRuns === null
    ? null
    : ratio(seasonTotalRuns, seasonScoreGames.length);
  const attendanceRunsPerGame = ratio(totalRuns, games.length);

  const b4Sides: { hr: B4Side; hitsAllowed: B4Side } = {
    hr: {
      attendancePerGame: ratio(att.hr, att.completeFinalGames),
      seasonPerGame: season ? ratio(season.hr, season.completeGames) : null,
      delta: null,
    },
    hitsAllowed: {
      attendancePerGame: ratio(att.hAllowed, att.completeFinalGames),
      seasonPerGame: season ? ratio(season.hAllowed, season.completeGames) : null,
      delta: null,
    },
  };
  for (const side of [b4Sides.hr, b4Sides.hitsAllowed]) {
    side.delta =
      side.attendancePerGame !== null && side.seasonPerGame !== null
        ? side.attendancePerGame - side.seasonPerGame
        : null;
  }
  const b4SampleMet = att.completeFinalGames >= MIN_FINAL_GAMES;

  return {
    b1: {
      value: {
        attendanceAvg,
        seasonAvg,
        delta: attendanceAvg !== null && seasonAvg !== null ? attendanceAvg - seasonAvg : null,
      },
      sampleMet: att.ab >= MIN_TEAM_AB,
      denominator: { attendanceAB: att.ab, seasonAB: season?.ab ?? 0 },
    },
    b2: {
      value: {
        attendanceEra,
        seasonEra,
        delta: attendanceEra !== null && seasonEra !== null ? attendanceEra - seasonEra : null,
      },
      sampleMet: att.outs >= MIN_TEAM_OUTS,
      denominator: { attendanceOuts: att.outs, seasonOuts: season?.outs ?? 0 },
    },
    b3: {
      value: {
        runsPerGame: attendanceRunsPerGame,
        seasonRunsPerGame,
        delta:
          attendanceRunsPerGame !== null && seasonRunsPerGame !== null
            ? attendanceRunsPerGame - seasonRunsPerGame
            : null,
        totalRuns,
      },
      sampleMet: games.length >= MIN_FINAL_GAMES,
      denominator: { finalGames: games.length, seasonGames: seasonScoreGames.length },
    },
    b4: {
      value: b4Sides,
      sampleMet: b4SampleMet,
      denominator: {
        attendanceGames: att.completeFinalGames,
        seasonGames: season?.completeGames ?? 0,
      },
      components: {
        hr: {
          state: b4SampleMet ? "ready" : "sample_limited",
          value: b4Sides.hr,
          n: att.completeFinalGames,
          denominator: {
            attendanceGames: att.completeFinalGames,
            seasonGames: season?.completeGames ?? 0,
          },
        },
        hitsAllowed: {
          state: b4SampleMet ? "ready" : "sample_limited",
          value: b4Sides.hitsAllowed,
          n: att.completeFinalGames,
          denominator: {
            attendanceGames: att.completeFinalGames,
            seasonGames: season?.completeGames ?? 0,
          },
        },
      },
    },
    unknownGames,
    finalGames: games.length,
  };
}

function buildB(
  ctx: Ctx,
  id: "B1" | "B2" | "B3" | "B4",
): MetricEnvelope {
  const { c } = ctx;
  // §5 — partial_data는 player-log 비교값(B1·B2·B4)에만. B3는 game 스코어 단독이라 제외.
  const usesLogs = id !== "B3";
  const seasonSourceOk = usesLogs
    ? ctx.seasonComparable && ctx.input.teamSeasonTotals !== null
    : true;
  const teamGames = new Map<number, ScopeGame[]>();
  for (const g of c.validFinal) {
    if (g.snapshotTeamId == null) continue;
    const list = teamGames.get(g.snapshotTeamId) ?? [];
    list.push(g);
    teamGames.set(g.snapshotTeamId, list);
  }
  const attendanceUnknownIds = c.validFinal.filter((g) => !g.complete).map((g) => g.gameId);
  const unknownGameIds = usesLogs ? [...new Set(attendanceUnknownIds)] : [];
  const unknownGames = unknownGameIds.length;

  const buildValueFor = (computed: BTeamComputed): {
    value: unknown;
    sampleMet: boolean;
    denominator: Record<string, number>;
    components?: Record<string, ComponentEnvelope>;
  } => {
    if (id === "B1") return computed.b1;
    if (id === "B2") return computed.b2;
    if (id === "B3") return computed.b3;
    return computed.b4;
  };

  const state = pipeline(ctx, {
    comparisonSourceSupported: seasonSourceOk,
    invalidSnapshotGames: c.invalidSnapshot.length,
    mixedTeamApplies: true,
    snapshotTeamCount: c.snapshotTeams.length,
    partialDataApplies: usesLogs,
    unknownGames,
    sampleMet:
      c.snapshotTeams.length === 1
        ? buildValueFor(computeBForTeam(ctx, c.snapshotTeams[0], teamGames.get(c.snapshotTeams[0]) ?? []))
            .sampleMet
        : true,
  });

  const envelope: MetricEnvelope = {
    id,
    state,
    value: null,
    n: c.validFinal.length,
    denominator: { ...EMPTY_DENOMINATORS[id] },
    coverage: {
      invalidSnapshot: c.invalidSnapshot,
      completeFinalGames: c.validFinal.filter((g) => g.complete).length,
      unknownGames,
      unknownGameIds,
    },
  };

  if (state === "mixed_team") {
    // §11 B mixed: top-level value=null·items=perTeam. 팀마다 ready|sample_limited|partial_data.
    envelope.items = c.snapshotTeams.map((teamId) => {
      const games = teamGames.get(teamId) ?? [];
      const computed = computeBForTeam(ctx, teamId, games);
      const part = buildValueFor(computed);
      const itemState: MetricState =
        usesLogs && computed.unknownGames > 0
          ? "partial_data"
          : part.sampleMet
            ? "ready"
            : "sample_limited";
      // 표본 미달 또는 시즌 baseline만 partial이면 직관 사실값만 노출한다.
      // 직관 경기 자체가 incomplete인 partial_data는 수치도 불완전하므로 전체 null.
      // ⚠️ mixed 여기서 part.value 는 BTeamValue 가 아니라 현재 id 하나의 값(B1Value 등)이다.
      // BTeamValue 로 cast 해 strip 하면 shape 가 깨져 attendanceAvg 까지 사라진다(2026-07-31 삼순 P0-1).
      const item: ItemEnvelope = {
        key: String(teamId),
        state: itemState,
        value:
          itemState === "partial_data"
            ? games.some((game) => !game.complete)
              ? null
              : stripSeasonBaseline(id, part.value)
            : itemState === "sample_limited"
              ? stripSeasonBaseline(id, part.value)
              : part.value,
        n: games.length,
        denominator: part.denominator,
        coverage: {
          unknownGames: computed.unknownGames,
          seasonSource: "current_snapshot",
        },
      };
      return item;
    });
    return envelope;
  }

  if (state !== "ready" && state !== "sample_limited" && state !== "partial_data") return envelope;

  const teamId = c.snapshotTeams[0];
  const computed = computeBForTeam(ctx, teamId, teamGames.get(teamId) ?? []);
  const part = buildValueFor(computed);
  const attendanceHasUnknown = attendanceUnknownIds.length > 0;
  envelope.denominator = part.denominator;
  // 표본 미달 또는 시즌 baseline만 partial이면 확정된 직관 사실값은 노출한다.
  // 시즌 baseline·delta는 null, 직관 경기 자체가 incomplete면 전체 null로 막는다.
  envelope.value =
    state === "ready"
      ? part.value
      : state === "sample_limited"
        ? stripSeasonBaseline(id, part.value)
        : attendanceHasUnknown
          ? null
          : stripSeasonBaseline(id, part.value);
  if (id === "B4" && part.components) {
    envelope.components = part.components;
    // sample_limited여도 component envelope로 세부 상태를 드러낸다 (§11).
    // 직관 값은 유지하되 시즌 baseline·delta는 동일하게 fail-closed.
    if (state === "sample_limited" || (state === "partial_data" && !attendanceHasUnknown)) {
      for (const component of Object.values(part.components)) {
        component.state = state;
        const side = component.value as B4Side | null;
        if (side) component.value = { attendancePerGame: side.attendancePerGame, seasonPerGame: null, delta: null };
      }
    }
  }
  return envelope;
}

// C ─ 최애 부스트
interface FavoriteAttendance {
  favorite: FavoritePlayerSnapshot;
  coverage: FavoriteCoverage;
  /** appearance 경기 행 (complete 경기 + row 존재). */
  batterRows: PlayerGameLogRow[];
  pitcherRows: PlayerGameLogRow[];
  appearanceGames: number;
}

function favoriteAttendance(ctx: Ctx, favorite: FavoritePlayerSnapshot): FavoriteAttendance {
  const coverage: FavoriteCoverage = {
    eligible: 0,
    complete: 0,
    appearances: 0,
    dnp: 0,
    unknown: 0,
    ratio: null,
    unknownGameIds: [],
  };
  const batterRows: PlayerGameLogRow[] = [];
  const pitcherRows: PlayerGameLogRow[] = [];
  const appearanceGameIds = new Set<string>();

  for (const g of ctx.c.all) {
    if (!g.isFinal) continue;
    const rows = (ctx.logsByGame.get(g.gameId) ?? []).filter(
      (row) => row.kbo_id === favorite.playerId,
    );
    const participates =
      rows.length > 0 ||
      (g.game !== null &&
        (g.game.awayTeamId === favorite.teamId || g.game.homeTeamId === favorite.teamId));
    if (!participates) continue;

    coverage.eligible += 1;
    if (!g.complete) {
      coverage.unknown += 1;
      coverage.unknownGameIds.push(g.gameId);
      continue;
    }
    coverage.complete += 1;
    if (rows.length === 0) {
      coverage.dnp += 1;
      continue;
    }
    coverage.appearances += 1;
    appearanceGameIds.add(g.gameId);
    for (const row of rows) {
      if (row.player_type === "batter") batterRows.push(row);
      else pitcherRows.push(row);
    }
  }
  coverage.ratio = ratio(coverage.complete, coverage.eligible);
  return {
    favorite,
    coverage,
    batterRows,
    pitcherRows,
    appearanceGames: appearanceGameIds.size,
  };
}

function favoriteSeasonBaseline(ctx: Ctx, favorite: FavoritePlayerSnapshot): FavoriteSeasonBaselineSnapshot | null {
  if (!ctx.seasonComparable || ctx.input.favoriteSeasonBaselines === null) return null;
  return ctx.input.favoriteSeasonBaselines.get(favorite.playerId) ?? null;
}

function cPipeline(ctx: Ctx, over: Partial<MetricStateInput>): MetricState {
  return pipeline(ctx, {
    favoriteRequired: true,
    favoriteCount: ctx.input.favorites.length,
    partialDataApplies: true,
    ...over,
  });
}

interface CContext {
  attendances: FavoriteAttendance[];
  baselines: Map<string, FavoriteSeasonBaselineSnapshot | null>;
}

function buildCContext(ctx: Ctx): CContext {
  const attendances = ctx.input.favorites.map((favorite) => favoriteAttendance(ctx, favorite));
  const baselines = new Map(
    ctx.input.favorites.map((favorite) => [
      favorite.playerId,
      favoriteSeasonBaseline(ctx, favorite),
    ]),
  );
  return { attendances, baselines };
}

function totalUnknown(cc: CContext): number {
  return cc.attendances.reduce((sum, a) => sum + a.coverage.unknown, 0);
}

function totalAttendanceUnknown(cc: CContext): number {
  return cc.attendances.reduce((sum, attendance) => sum + attendance.coverage.unknown, 0);
}

function playerUnknown(a: FavoriteAttendance): number {
  return a.coverage.unknown;
}

function playerCoverage(
  a: FavoriteAttendance,
  baseline: FavoriteSeasonBaselineSnapshot | null,
): Record<string, unknown> {
  return {
    ...a.coverage,
    season: { source: "current_snapshot", available: baseline !== null },
  };
}

function cCoverageSummary(cc: CContext): Record<string, unknown> {
  return {
    perPlayer: cc.attendances.map((a) => ({
      playerId: a.favorite.playerId,
      ...playerCoverage(a, cc.baselines.get(a.favorite.playerId) ?? null),
    })),
  };
}

function cAttendanceCoverageSummary(cc: CContext): Record<string, unknown> {
  return {
    perPlayer: cc.attendances.map((attendance) => ({
      playerId: attendance.favorite.playerId,
      ...attendance.coverage,
    })),
  };
}

function eligibleTotal(cc: CContext): number {
  return cc.attendances.reduce((sum, a) => sum + a.coverage.eligible, 0);
}

// C1/C2 item 공통 골격
function favoriteItemState(
  ctx: Ctx,
  unknownGames: number,
  sampleMet: boolean,
  needsBaseline: boolean,
  baselineAvailable: boolean,
): MetricState {
  if (needsBaseline && !(ctx.seasonComparable && baselineAvailable)) return "attendance_only";
  if (unknownGames > 0) return "partial_data";
  if (!sampleMet) return "sample_limited";
  return "ready";
}

function buildC1(ctx: Ctx, cc: CContext): MetricEnvelope<C1Entry[]> {
  const state = cPipeline(ctx, { unknownGames: totalUnknown(cc), comparisonSourceSupported: ctx.seasonComparable && ctx.input.favoriteSeasonBaselines !== null });
  const envelope: MetricEnvelope<C1Entry[]> = {
    id: "C1",
    state,
    value: [],
    n: 0,
    denominator: { eligibleAttendanceGames: eligibleTotal(cc) },
    coverage: cCoverageSummary(cc),
    items: [],
  };
  if (state === "empty" || state === "no_final" || state === "no_favorite" || state === "attendance_only") {
    return envelope;
  }

  const itemStates: MetricState[] = [];
  for (const a of cc.attendances) {
    const baseline = cc.baselines.get(a.favorite.playerId) ?? null;
    // 시즌 baseline이 투수 역할만 증명하면 unknown 경기 때문에 C1 타자 item을 만들지 않는다.
    // 역할이 불명확한 최애는 unknown_log_gap을 숨기지 않도록 item을 유지한다.
    if (
      a.batterRows.length === 0 &&
      (a.coverage.unknown === 0 || (baseline?.pitcher != null && baseline.batter == null))
    ) continue;
    const ab = a.batterRows.reduce((s, r) => s + r.ab, 0);
    const h = a.batterRows.reduce((s, r) => s + r.h, 0);
    const hr = a.batterRows.reduce((s, r) => s + r.hr, 0);
    const rbi = a.batterRows.reduce((s, r) => s + r.rbi, 0);
    const games = new Set(a.batterRows.map((r) => r.game_id)).size;
    const itemState = favoriteItemState(
      ctx,
      playerUnknown(a),
      ab >= MIN_FAVORITE_AB,
      true,
      baseline?.batter != null,
    );
    itemStates.push(itemState);
    const attendanceOnly = itemState === "partial_data" && a.coverage.unknown === 0;
    const entry: C1Entry | null =
      itemState === "ready" || attendanceOnly
        ? {
            playerId: a.favorite.playerId,
            attendanceAvg: pooledAvg(h, ab),
            seasonAvg: attendanceOnly || !baseline?.batter
              ? null
              : pooledAvg(baseline.batter.h, baseline.batter.ab),
            deltaAvg: null,
            attendanceHrPerGame: ratio(hr, games),
            seasonHrPerGame: attendanceOnly || !baseline?.batter
              ? null
              : ratio(baseline.batter.hr, baseline.batter.games),
            attendanceRbiPerGame: ratio(rbi, games),
            seasonRbiPerGame: attendanceOnly || !baseline?.batter
              ? null
              : ratio(baseline.batter.rbi, baseline.batter.games),
            appearances: games,
            ab,
          }
        : null;
    if (entry && entry.attendanceAvg !== null && entry.seasonAvg !== null) {
      entry.deltaAvg = entry.attendanceAvg - entry.seasonAvg;
    }
    if (entry) envelope.value!.push(entry);
    envelope.items!.push({
      key: a.favorite.playerId,
      state: itemState,
      value: entry,
      n: games,
      denominator: { attendanceAB: ab, seasonAB: baseline?.batter?.ab ?? 0 },
      coverage: playerCoverage(a, baseline),
    });
  }
  envelope.n = envelope.items!.length;
  envelope.state = itemStates.length > 0 ? worstState(itemStates) : state;
  return envelope;
}

function buildC2(ctx: Ctx, cc: CContext): MetricEnvelope<C2Entry[]> {
  const state = cPipeline(ctx, { unknownGames: totalUnknown(cc), comparisonSourceSupported: ctx.seasonComparable && ctx.input.favoriteSeasonBaselines !== null });
  const envelope: MetricEnvelope<C2Entry[]> = {
    id: "C2",
    state,
    value: [],
    n: 0,
    denominator: { eligibleAttendanceGames: eligibleTotal(cc) },
    coverage: cCoverageSummary(cc),
    items: [],
  };
  if (state === "empty" || state === "no_final" || state === "no_favorite" || state === "attendance_only") {
    return envelope;
  }

  const itemStates: MetricState[] = [];
  for (const a of cc.attendances) {
    const baseline = cc.baselines.get(a.favorite.playerId) ?? null;
    // C1과 대칭: 시즌 baseline이 타자 역할만 증명하면 C2 투수 item을 만들지 않는다.
    if (
      a.pitcherRows.length === 0 &&
      (a.coverage.unknown === 0 || (baseline?.batter != null && baseline.pitcher == null))
    ) continue;
    const outs = a.pitcherRows.reduce((s, r) => s + r.ip_outs, 0);
    const er = a.pitcherRows.reduce((s, r) => s + r.er, 0);
    const k = a.pitcherRows.reduce((s, r) => s + r.k, 0);
    const games = new Set(a.pitcherRows.map((r) => r.game_id)).size;
    const itemState = favoriteItemState(
      ctx,
      playerUnknown(a),
      outs >= MIN_FAVORITE_OUTS,
      true,
      baseline?.pitcher != null,
    );
    itemStates.push(itemState);
    let entry: C2Entry | null = null;
    const attendanceOnly = itemState === "partial_data" && a.coverage.unknown === 0;
    if (itemState === "ready" || attendanceOnly) {
      const attendanceEra = pooledEra(er, outs);
      const seasonEra = !attendanceOnly && baseline?.pitcher
        ? pooledEra(baseline.pitcher.er, baseline.pitcher.outs)
        : null;
      const attendanceK9 = pooledK9(k, outs);
      const seasonK9 = !attendanceOnly && baseline?.pitcher
        ? pooledK9(baseline.pitcher.k, baseline.pitcher.outs)
        : null;
      entry = {
        playerId: a.favorite.playerId,
        attendanceEra,
        seasonEra,
        eraImprovement:
          attendanceEra !== null && seasonEra !== null ? seasonEra - attendanceEra : null,
        attendanceK9,
        seasonK9,
        k9Delta: attendanceK9 !== null && seasonK9 !== null ? attendanceK9 - seasonK9 : null,
        appearances: games,
        outs,
      };
      envelope.value!.push(entry);
    }
    envelope.items!.push({
      key: a.favorite.playerId,
      state: itemState,
      value: entry,
      n: games,
      denominator: { attendanceOuts: outs, seasonOuts: baseline?.pitcher?.outs ?? 0 },
      coverage: playerCoverage(a, baseline),
    });
  }
  envelope.n = envelope.items!.length;
  envelope.state = itemStates.length > 0 ? worstState(itemStates) : state;
  return envelope;
}

function buildC4(ctx: Ctx, cc: CContext): MetricEnvelope<C4Entry[]> {
  const state = cPipeline(ctx, { unknownGames: totalAttendanceUnknown(cc) });
  const envelope: MetricEnvelope<C4Entry[]> = {
    id: "C4",
    state,
    value: [],
    n: 0,
    denominator: { eligibleAttendanceGames: eligibleTotal(cc) },
    coverage: cAttendanceCoverageSummary(cc),
    items: [],
  };
  if (state !== "ready" && state !== "sample_limited" && state !== "partial_data") return envelope;

  for (const a of cc.attendances) {
    if (a.batterRows.length === 0 && a.pitcherRows.length === 0 && a.coverage.unknown === 0) continue;
    const hits = a.batterRows.reduce((s, r) => s + r.h, 0);
    const rbi = a.batterRows.reduce((s, r) => s + r.rbi, 0);
    const homeRuns = a.batterRows.reduce((s, r) => s + r.hr, 0);
    const strikeouts = a.pitcherRows.reduce((s, r) => s + r.k, 0);
    const zeroEarnedRunGames = new Set(
      a.pitcherRows
        .filter((row) => row.ip_outs > 0 && row.er === 0)
        .map((row) => row.game_id),
    ).size;
    const games = new Set([...a.batterRows, ...a.pitcherRows].map((r) => r.game_id)).size;
    const itemState: MetricState =
      a.coverage.unknown > 0 ? "partial_data" : "ready";
    const entry: C4Entry | null =
      itemState === "ready"
        ? {
            playerId: a.favorite.playerId,
            homeRuns,
            appearanceGames: games,
            batter: a.batterRows.length > 0 ? { hits, rbi, homeRuns } : null,
            pitcher: a.pitcherRows.length > 0 ? { strikeouts, zeroEarnedRunGames } : null,
          }
        : null;
    if (entry) envelope.value!.push(entry);
    envelope.items!.push({
      key: a.favorite.playerId,
      state: itemState,
      value: entry,
      n: games,
      denominator: { appearanceGames: games },
      coverage: playerCoverage(a, null),
    });
  }
  envelope.n = envelope.items!.length;
  const itemStates = envelope.items!.map((i) => i.state);
  envelope.state = itemStates.length > 0 ? worstState(itemStates) : state;
  return envelope;
}

const BATTER_TOP_ORDER: Array<[keyof PlayerGameLogRow, 1 | -1]> = [
  ["hr", -1], ["h", -1], ["rbi", -1], ["bb", -1], ["game_date", -1], ["game_id", 1],
];
const PITCHER_TOP_ORDER: Array<[keyof PlayerGameLogRow, 1 | -1]> = [
  ["ip_outs", -1], ["er", 1], ["k", -1], ["h_allowed", 1], ["game_date", -1], ["game_id", 1],
];

function topRow(rows: PlayerGameLogRow[], order: Array<[keyof PlayerGameLogRow, 1 | -1]>): PlayerGameLogRow | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    for (const [field, dir] of order) {
      const va = a[field];
      const vb = b[field];
      if (va === vb) continue;
      return (va! < vb! ? -1 : 1) * dir;
    }
    return 0;
  });
  return sorted[0];
}

function buildC5(ctx: Ctx, cc: CContext): MetricEnvelope<C5Entry[]> {
  const state = cPipeline(ctx, { unknownGames: totalAttendanceUnknown(cc) });
  const envelope: MetricEnvelope<C5Entry[]> = {
    id: "C5",
    state,
    value: [],
    n: 0,
    denominator: { eligibleAttendanceGames: eligibleTotal(cc) },
    coverage: cAttendanceCoverageSummary(cc),
    items: [],
  };
  if (state !== "ready" && state !== "sample_limited" && state !== "partial_data") return envelope;

  for (const a of cc.attendances) {
    if (a.batterRows.length === 0 && a.pitcherRows.length === 0 && a.coverage.unknown === 0) continue;
    const itemState: MetricState =
      a.coverage.unknown > 0 ? "partial_data" : "ready";
    let entry: C5Entry | null = null;
    if (itemState === "ready") {
      entry = { playerId: a.favorite.playerId };
      // §10 C5 — 이도류는 타입별 1건, 동률도 lexicographic 순서로 결정.
      const batter = topRow(a.batterRows, BATTER_TOP_ORDER);
      const pitcher = topRow(a.pitcherRows, PITCHER_TOP_ORDER);
      if (batter) {
        entry.batterTop = {
          gameId: batter.game_id,
          date: batter.game_date,
          ab: batter.ab, h: batter.h, hr: batter.hr, rbi: batter.rbi, bb: batter.bb,
        };
      }
      if (pitcher) {
        entry.pitcherTop = {
          gameId: pitcher.game_id,
          date: pitcher.game_date,
          ipOuts: pitcher.ip_outs, er: pitcher.er, k: pitcher.k, hAllowed: pitcher.h_allowed,
        };
      }
      envelope.value!.push(entry);
    }
    envelope.items!.push({
      key: a.favorite.playerId,
      state: itemState,
      value: entry,
      n: a.appearanceGames,
      denominator: { appearanceGames: a.appearanceGames },
      coverage: playerCoverage(a, null),
    });
  }
  envelope.n = envelope.items!.length;
  const itemStates = envelope.items!.map((i) => i.state);
  envelope.state = itemStates.length > 0 ? worstState(itemStates) : state;
  return envelope;
}

function buildC6(
  ctx: Ctx,
  cc: CContext,
  c1: MetricEnvelope<C1Entry[]>,
  c2: MetricEnvelope<C2Entry[]>,
): MetricEnvelope<C6Value> {
  const state = cPipeline(ctx, { unknownGames: totalUnknown(cc), comparisonSourceSupported: ctx.seasonComparable && ctx.input.favoriteSeasonBaselines !== null });
  const envelope: MetricEnvelope<C6Value> = {
    id: "C6",
    state,
    value: null,
    n: 0,
    denominator: { eligibleAttendanceGames: eligibleTotal(cc) },
    coverage: cCoverageSummary(cc),
  };
  if (state === "empty" || state === "no_final" || state === "no_favorite" || state === "attendance_only") {
    return envelope;
  }

  // §9 C6 — metric별 표본 가드를 통과한(ready) 현재 최애가 역할별 2명 이상일 때만 ranking.
  const batterQualified = (c1.value ?? []).filter(
    (e) => e.attendanceAvg !== null && e.seasonAvg !== null,
  );
  const pitcherQualified = (c2.value ?? []).filter(
    (e) => e.attendanceEra !== null && e.seasonEra !== null,
  );
  const batterRanking = batterQualified
    .map((e) => ({
      playerId: e.playerId,
      boostPct: (e.attendanceAvg! - e.seasonAvg!) / Math.max(e.seasonAvg!, 0.001),
    }))
    .sort((a, b) => b.boostPct - a.boostPct || (a.playerId < b.playerId ? -1 : 1));
  const pitcherRanking = pitcherQualified
    .map((e) => ({
      playerId: e.playerId,
      boostPct: (e.seasonEra! - e.attendanceEra!) / Math.max(e.seasonEra!, 0.001),
    }))
    .sort((a, b) => b.boostPct - a.boostPct || (a.playerId < b.playerId ? -1 : 1));

  const batterReady = batterRanking.length >= 2;
  const pitcherReady = pitcherRanking.length >= 2;
  envelope.components = {
    batterRanking: {
      state: batterReady ? "ready" : "sample_limited",
      value: batterReady ? batterRanking : null,
      n: batterRanking.length,
      denominator: { qualifiedPlayers: batterRanking.length },
    },
    pitcherRanking: {
      state: pitcherReady ? "ready" : "sample_limited",
      value: pitcherReady ? pitcherRanking : null,
      n: pitcherRanking.length,
      denominator: { qualifiedPlayers: pitcherRanking.length },
    },
  };
  envelope.n = batterRanking.length + pitcherRanking.length;
  // §10 — 역할 간 직접 통합정렬 금지. 역할별 2명 미만이면 해당 ranking만 sample_limited.
  if (totalUnknown(cc) > 0) {
    envelope.state = "partial_data";
    return envelope;
  }
  envelope.state = worstState(
    Object.values(envelope.components).map((component) => component.state),
  );
  if (batterReady || pitcherReady) {
    envelope.value = {
      batterRanking: batterReady ? batterRanking : [],
      pitcherRanking: pitcherReady ? pitcherRanking : [],
    };
  }
  return envelope;
}

// D ─ 관전 서사

function buildD1(ctx: Ctx): MetricEnvelope<D1Value> {
  const { c } = ctx;
  const state = pipeline(ctx, {
    invalidSnapshotGames: c.invalidSnapshot.length,
    sampleMet: c.validFinal.length >= MIN_FINAL_GAMES,
  });
  const closeGames = c.validFinal.filter(
    (g) => Math.abs((g.myScore ?? 0) - (g.oppScore ?? 0)) <= 1,
  ).length;
  const avgRunDiff = ratio(
    c.validFinal.reduce((sum, g) => sum + ((g.myScore ?? 0) - (g.oppScore ?? 0)), 0),
    c.validFinal.length,
  );
  const closeGameRate = ratio(closeGames, c.validFinal.length);
  const computable = state === "ready" || state === "sample_limited";
  const componentState = state === "ready" ? "ready" : state;
  const envelope: MetricEnvelope<D1Value> = {
    id: "D1",
    state,
    value: state === "ready" ? { avgRunDiff, closeGameRate, closeGames } : null,
    n: c.validFinal.length,
    denominator: { finalGames: c.validFinal.length },
    coverage: { invalidSnapshot: c.invalidSnapshot },
  };
  if (computable) {
    envelope.components = {
      avgRunDiff: {
        state: componentState,
        value: state === "ready" ? avgRunDiff : null,
        n: c.validFinal.length,
        denominator: { finalGames: c.validFinal.length },
      },
      closeGameRate: {
        state: componentState,
        value: state === "ready" ? closeGameRate : null,
        n: c.validFinal.length,
        denominator: { finalGames: c.validFinal.length },
      },
    };
  }
  return envelope;
}

function buildD5(ctx: Ctx): MetricEnvelope<D5Value> {
  const { c } = ctx;
  // §5 누적 사실형 — 1건부터 ready·n 노출. §10 상 invalid_snapshot 적용 대상 아님.
  const state = pipeline(ctx, {});
  const cancelledCount = c.all.filter((g) => g.isCancelled).length;
  return {
    id: "D5",
    state: state === "empty" ? "empty" : "ready",
    value: state === "empty" ? null : { cancelledCount },
    n: c.all.length,
    denominator: { attendanceGames: c.all.length },
    coverage: {
      unavailableGames: c.all.filter((g) => g.game === null).length,
    },
  };
}

function buildD6(ctx: Ctx): MetricEnvelope<D6Value> {
  const { c } = ctx;
  const state = pipeline(ctx, {
    invalidSnapshotGames: c.invalidSnapshot.length,
  });
  const envelope: MetricEnvelope<D6Value> = {
    id: "D6",
    state,
    value: null,
    n: c.validFinal.length,
    denominator: { finalGames: c.validFinal.length },
    coverage: { invalidSnapshot: c.invalidSnapshot },
  };
  if (state !== "ready") return envelope;

  // §10 D6 — 동률은 최신 date desc 후 gameId asc.
  const byTop = (a: ScopeGame, b: ScopeGame, score: (g: ScopeGame) => number) =>
    score(b) - score(a) ||
    (a.gameDate > b.gameDate ? -1 : a.gameDate < b.gameDate ? 1 : 0) ||
    (a.gameId < b.gameId ? -1 : 1);

  const maxRunsGame = [...c.validFinal].sort((a, b) => byTop(a, b, (g) => g.myScore ?? 0))[0];
  const wins = c.validFinal.filter((g) => g.result === "W");
  const maxMarginGame = [...wins].sort((a, b) =>
    byTop(a, b, (g) => (g.myScore ?? 0) - (g.oppScore ?? 0)),
  )[0];

  const maxTeamRuns = {
    gameId: maxRunsGame.gameId,
    date: maxRunsGame.gameDate,
    runs: maxRunsGame.myScore ?? 0,
  };
  const maxMarginWin = maxMarginGame
    ? {
        gameId: maxMarginGame.gameId,
        date: maxMarginGame.gameDate,
        margin: (maxMarginGame.myScore ?? 0) - (maxMarginGame.oppScore ?? 0),
      }
    : null;

  // §12 D6 ready+no_wins 고정 payload — leaf 승격 규칙 적용 예시 그대로.
  envelope.value = { maxTeamRuns, maxMarginWin };
  envelope.components = {
    maxTeamRuns: {
      state: "ready",
      value: maxTeamRuns,
      n: c.validFinal.length,
      denominator: { finalGames: c.validFinal.length },
    },
    maxMarginWin: maxMarginWin
      ? {
          state: "ready",
          value: maxMarginWin,
          n: wins.length,
          denominator: { wins: wins.length },
        }
      : { state: "no_wins", value: null, n: 0, denominator: { wins: 0 } },
  };
  envelope.state = worstState(
    Object.values(envelope.components).map((component) => component.state),
  );
  return envelope;
}

/**
 /**
 * D7 — 내가 본 경기의 수비 실책 (하린아빠 2026-08-02 `발암경기 인내형` 태그 근거).
 *
 * 데이터 소스는 **linescore 의 `E`(팀별 실책)** 다. 실책은 팀 단위 지표라 선수별로
 * 쪼갤 이유가 없고, `player_game_logs` 에 컬럼을 더하면 canonical payload hash 가
 * 바뀌어 운영 complete 원장 468건이 통째로 `payload_hash_mismatch` 가 된다.
 *
 * ⚠️ 핵심 계약: 조회 실패 경기는 `gameErrors` 에 **키 자체가 없다**. 그걸 0으로 세면
 * "실책을 안 본 사람"으로 둔갑하므로, **아는 경기만 분모**로 쓰고 그 수를 `knownGames`
 * 로 노출한다. 모르는 경기 수도 `coverage.unknownErrorGames` 로 숨기지 않는다.
 */
function buildD7(ctx: Ctx): MetricEnvelope<D7Value> {
  const { c } = ctx;
  const known = c.validFinal.filter((g) => ctx.input.gameErrors.has(g.gameId));

  const state = pipeline(ctx, {
    invalidSnapshotGames: c.invalidSnapshot.length,
    sampleMet: known.length >= MIN_FINAL_GAMES,
  });

  const envelope: MetricEnvelope<D7Value> = {
    id: "D7",
    // ⚠️ §12 사다리(`invalid_snapshot > no_final > sample_limited`)를 덮지 않는다(삼순 P1).
    //    이전 구현은 `known===0` 이면 `empty` 외 전부 `sample_limited` 로 덮어써서
    //    cancelled-only(`no_final`)·snapshot 결측/불일치(`invalid_snapshot`)까지 지웠다.
    //    실책을 못 구한 것은 **정상 final 인데 소스가 없을 때**만 표본 문제다.
    state: known.length === 0 && state === "ready" ? "sample_limited" : state,
    value: null,
    n: known.length,
    denominator: { knownErrorGames: known.length },
    coverage: {
      invalidSnapshot: c.invalidSnapshot,
      unknownErrorGames: c.validFinal.length - known.length,
    },
  };
  // ⚠️ 표본 미달이어도 **사실값은 보존**한다 (삼순 P1 2026-08-02).
  //    실책은 "내가 본 그 경기에서 실제로 몇 개 나왔나"라는 관측 사실이라, 표본이 1경기여도
  //    거짓이 아니다. 여기서 value 를 null 로 버리면 실측 P50(1경기) 유저는 어떤 실책 태그도
  //    받을 수 없다(48명 중 47명). 표본 부족은 `state=sample_limited` 배지로만 알리고,
  //    "이 사람은 원래 그렇다"는 **성향 주장**은 소비측(`venueErrorTags`)이 3경기+로 가드한다.
  //    A1 이 표본 미달에서도 승·패·승률을 노출하는 것과 같은 계약이다.
  if (known.length === 0) return envelope;
  if (envelope.state !== "ready" && envelope.state !== "sample_limited") return envelope;

  let myTeamErrors = 0;
  let opponentErrors = 0;
  let errorProneGames = 0;
  let worst: { gameId: string; date: string; errors: number } | null = null;
  for (const g of known) {
    const counts = ctx.input.gameErrors.get(g.gameId)!;
    // 내 팀이 홈이었나 원정이었나에 따라 귀속을 뒤집는다.
    // isHome 이 null 이면 snapshot 유효성 자체가 깨진 경기이므로 known 에 못 들어온다.
    const mine = g.isHome ? counts.home : counts.away;
    const theirs = g.isHome ? counts.away : counts.home;
    myTeamErrors += mine;
    opponentErrors += theirs;
    // `발암경기` = 한 경기에서 내 팀 실책이 임계 이상. 실측 상위 16.2% 구간.
    if (mine >= ERROR_PRONE_MIN) errorProneGames += 1;
    // 동률은 최신 date desc → gameId asc (D6 와 동일 정렬 계약).
    if (
      mine > 0 &&
      (worst === null ||
        mine > worst.errors ||
        (mine === worst.errors && g.gameDate > worst.date) ||
        (mine === worst.errors && g.gameDate === worst.date && g.gameId < worst.gameId))
    ) {
      worst = { gameId: g.gameId, date: g.gameDate, errors: mine };
    }
  }

  envelope.value = {
    myTeamErrors,
    opponentErrors,
    errorProneGames,
    myErrorsPerGame: ratio(myTeamErrors, known.length),
    knownGames: known.length,
    worstGame: worst,
  };
  return envelope;
}

// E ─ 습관·마일스톤
function streaks(schedule: string[], attended: Set<string>): { current: number; longest: number } {
  let longest = 0;
  let run = 0;
  for (const gameId of schedule) {
    if (attended.has(gameId)) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  // current — 팀의 가장 최근 final 경기까지 끊기지 않은 길이 (§9. 최근 경기를 안 갔으면 0).
  return { current: run, longest };
}

function buildE1(ctx: Ctx): MetricEnvelope<E1Value> {
  const { c, input } = ctx;
  const scheduleAvailable = seasonUniverseAvailable(ctx) && ctx.seasonComparable;
  const state: MetricState = !scheduleAvailable
    ? "unsupported"
    : pipeline(ctx, { invalidSnapshotGames: c.invalidSnapshot.length });
  const envelope: MetricEnvelope<E1Value> = {
    id: "E1",
    state,
    value: null,
    n: c.validFinal.length,
    denominator: { eligibleTeamFinalGames: 0 },
    coverage: { invalidSnapshot: c.invalidSnapshot },
  };
  if (state === "unsupported") {
    envelope.reasons = ["schedule_unavailable"];
    return envelope;
  }
  if (state !== "ready" && state !== "sample_limited") return envelope;

  // §9 E1 — 같은 snapshot 팀의 정규시즌 final 일정에서 연속 참석 game_id 길이.
  // 일정 소스: 정규 final 전체 경기 우주(game_id 참가팀 코드 파싱). DH는 game_id 오름차순 별도 순서.
  const perTeam: E1PerTeam[] = [];
  let eligibleTotalGames = 0;
  const teamsToEvaluate = new Set<number>(c.snapshotTeams);
  if (input.currentTeamId != null) teamsToEvaluate.add(input.currentTeamId);
  for (const teamId of [...teamsToEvaluate].sort((a, b) => a - b)) {
    const code = TEAM_ID_TO_CODE[teamId];
    if (!code) continue;
    const schedule = input
      .seasonGames!.filter((g) => g.teamCodes.includes(code))
      .sort((a, b) =>
        a.gameDate < b.gameDate ? -1 : a.gameDate > b.gameDate ? 1 : a.gameId < b.gameId ? -1 : 1,
      )
      .map((g) => g.gameId);
    const attended = new Set(
      c.validFinal.filter((g) => g.snapshotTeamId === teamId).map((g) => g.gameId),
    );
    if (schedule.length === 0) continue;
    eligibleTotalGames += schedule.length;
    const { current, longest } = streaks(schedule, attended);
    perTeam.push({ teamId, current, longest });
  }

  const longest = perTeam.reduce((max, t) => Math.max(max, t.longest), 0);
  const currentEntry =
    input.currentTeamId != null
      ? perTeam.find((t) => t.teamId === input.currentTeamId) ?? null
      : null;
  envelope.denominator.eligibleTeamFinalGames = eligibleTotalGames;
  envelope.value = {
    current: currentEntry ? currentEntry.current : null,
    longest,
    perTeam,
  };
  envelope.components = {
    current: {
      state: currentEntry ? "ready" : "no_final",
      value: currentEntry ? currentEntry.current : null,
      n: currentEntry ? 1 : 0,
      denominator: { teams: currentEntry ? 1 : 0 },
      reasons: currentEntry ? undefined : ["no_current_team_schedule"],
    },
    longest: {
      state: "ready",
      value: longest,
      n: perTeam.length,
      denominator: { teams: perTeam.length },
    },
    perTeam: {
      state: "ready",
      value: perTeam,
      n: perTeam.length,
      denominator: { teams: perTeam.length },
    },
  };
  return envelope;
}

function buildE2(ctx: Ctx): MetricEnvelope<E2Value> {
  const { c } = ctx;
  const state = pipeline(ctx, {});
  if (state === "empty") {
    return { ...emptyMetric("E2", "empty"), id: "E2" } as MetricEnvelope<E2Value>;
  }
  const monthlyMap = new Map<number, number>();
  for (const g of c.all) {
    const month = Number(g.gameDate.slice(5, 7));
    monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + 1);
  }
  const monthly = [...monthlyMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([month, count]) => ({ month, count }));
  const value: E2Value = {
    seasonCount: c.all.length,
    monthly,
    avgPerActiveMonth: ratio(c.all.length, monthly.length),
  };
  return {
    id: "E2",
    state: "ready",
    value,
    n: c.all.length,
    denominator: { activeMonths: monthly.length },
    coverage: {},
    components: {
      seasonCount: {
        state: "ready", value: value.seasonCount, n: c.all.length,
        denominator: { attendanceGames: c.all.length },
      },
      monthly: {
        state: "ready", value: monthly, n: monthly.length,
        denominator: { activeMonths: monthly.length },
      },
      avgPerActiveMonth: {
        state: "ready", value: value.avgPerActiveMonth, n: c.all.length,
        denominator: { activeMonths: monthly.length },
      },
    },
  };
}

function buildE3(ctx: Ctx): MetricEnvelope<E3Value> {
  const { c, input } = ctx;
  const state = pipeline(ctx, {});
  if (state === "empty") {
    // §11 — E3 firstDate/daysSinceFirst/totalGames도 value=null(n=0).
    return emptyMetric("E3", "empty") as MetricEnvelope<E3Value>;
  }
  const first = [...c.all].sort((a, b) => (a.gameDate < b.gameDate ? -1 : 1))[0];
  const value: E3Value = {
    firstAttendanceDate: first.gameDate,
    daysSinceFirst: daysBetween(first.gameDate, input.todayKst),
    totalGames: c.all.length,
  };
  return {
    id: "E3",
    state: "ready",
    value,
    n: c.all.length,
    denominator: { attendanceGames: c.all.length },
    coverage: {},
    components: {
      firstAttendanceDate: {
        state: "ready", value: value.firstAttendanceDate, n: c.all.length,
        denominator: { attendanceGames: c.all.length },
      },
      daysSinceFirst: {
        state: "ready", value: value.daysSinceFirst, n: c.all.length,
        denominator: { attendanceGames: c.all.length },
      },
      totalGames: {
        state: "ready", value: value.totalGames, n: c.all.length,
        denominator: { attendanceGames: c.all.length },
      },
    },
  };
}

function buildE4(ctx: Ctx, cc: CContext): MetricEnvelope<E4Value> {
  const { c, input } = ctx;
  const state = pipeline(ctx, {});
  if (state === "empty") {
    return emptyMetric("E4", "empty") as MetricEnvelope<E4Value>;
  }

  const stadiumCounts = new Map<string, number>();
  for (const g of c.all) {
    if (!g.stadium) continue;
    stadiumCounts.set(g.stadium, (stadiumCounts.get(g.stadium) ?? 0) + 1);
  }
  // §10 — 동률은 count desc → name asc.
  const topStadium =
    [...stadiumCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([name, count]) => ({ name, count }))[0] ?? null;

  // §10 — mostSeenFavorites는 현재 최애의 complete-game appearance만, dnp 제외.
  // E4는 시즌 비교 C계열이 아니라 직관 complete-game appearance 사실형이다.
  const favoriteUnknown = cc.attendances.reduce(
    (sum, attendance) => sum + attendance.coverage.unknown,
    0,
  );
  const mostSeen = cc.attendances
    .filter((a) => a.appearanceGames > 0)
    .map((a) => ({ playerId: a.favorite.playerId, appearances: a.appearanceGames }))
    .sort((a, b) => b.appearances - a.appearances || (a.playerId < b.playerId ? -1 : 1));
  const favoriteState: MetricState =
    input.favorites.length === 0
      ? "no_favorite"
      : favoriteUnknown > 0
        ? "partial_data"
        : "ready";

  const components = {
    topStadium: {
      state: (topStadium ? "ready" : "no_final") as MetricState,
      value: topStadium,
      n: c.all.length,
      denominator: { attendanceGames: c.all.length },
    },
    mostSeenFavorites: {
      state: favoriteState,
      value: favoriteState === "ready" ? mostSeen : null,
      n: mostSeen.length,
      denominator: { favorites: input.favorites.length },
    },
  };
  // §11 — E4는 topStadium ready여도 favorite 쪽은 no_favorite|partial_data일 수 있어 각각 독립 state.
  return {
    id: "E4",
    state: worstState(Object.values(components).map((component) => component.state)),
    value: {
      topStadium,
      mostSeenFavorites: favoriteState === "ready" ? mostSeen : [],
    },
    n: c.all.length,
    denominator: { attendanceGames: c.all.length },
    coverage: {},
    components,
  };
}

// ── entry point ──────────────────────────────────────────────────────────────

/** §9 Scope 1개(overall 또는 gps)를 계산한다. 두 scope는 동일 스키마 (§5). */
export function buildVenueStatsScope(input: VenueStatsAggregateInput): VenueStatsScopePayload {
  const c = classify(input);
  const logsByGame = new Map<string, PlayerGameLogRow[]>();
  for (const log of input.attendanceLogs) {
    const list = logsByGame.get(log.game_id) ?? [];
    list.push(log);
    logsByGame.set(log.game_id, list);
  }
  const ctx: Ctx = {
    input,
    c,
    seasonComparable: input.season === input.supportedSeason,
    logsByGame,
  };

  const coverage = {
    attendanceGames: c.all.length,
    finalGames: c.validFinal.length,
    cancelledGames: c.all.filter((g) => g.isCancelled).length,
    unavailableGames: c.all.filter((g) => g.game === null).length,
    dedupedRows: c.dedupedRows,
    incompleteFinalGames: c.all.filter((g) => g.isFinal && !g.complete).length,
    invalidSnapshot: c.invalidSnapshot,
  };
  const filter = {
    scope: input.scope,
    sources:
      input.scope === "gps" ? ["story_geofence"] : ["story_geofence", "diary_manual"],
  };

  if (c.all.length === 0) {
    // §11 empty contract — 모든 metric n=0, 숫자 위조 금지.
    const metrics = {} as Record<MetricId, MetricEnvelope>;
    for (const id of Object.keys(EMPTY_DENOMINATORS) as MetricId[]) {
      metrics[id] = emptyMetric(id, "empty");
    }
    return { state: "empty", filter, coverage, metrics };
  }

  const cc = buildCContext(ctx);
  const c1 = buildC1(ctx, cc);
  const c2 = buildC2(ctx, cc);

  const metrics: Record<MetricId, MetricEnvelope> = {
    A1: buildA1(ctx),
    A2: buildSplit<A2Cell>(ctx, "A2", (g) => String(g.opponentTeamId), (key, agg) => ({
      opponentTeamId: Number(key), ...agg,
    })),
    A3: buildSplit<A3Cell>(
      ctx,
      "A3",
      (g) => (g.stadium ? `${g.stadium}|${g.isHome ? "home" : "away"}` : null),
      (key, agg) => {
        const [stadium, homeAway] = key.split("|");
        return { stadium, homeAway: homeAway as "home" | "away", ...agg };
      },
    ),
    A4: buildSplit<A4Cell>(ctx, "A4", (g) => String(kstWeekday(g.gameDate)), (key, agg) => ({
      weekday: Number(key), ...agg,
    })),
    A5: withDayGameOpportunity(
      ctx,
      buildSplit<A5Cell>(ctx, "A5", (g) => dayNightOf(g.game), (key, agg) => ({
        dayNight: key as "day" | "night", ...agg,
      })),
    ),
    A6: buildSplit<A6Cell>(ctx, "A6", (g) => String(Number(g.gameDate.slice(5, 7))), (key, agg) => ({
      month: Number(key), ...agg,
    })),
    B1: buildB(ctx, "B1"),
    B2: buildB(ctx, "B2"),
    B3: buildB(ctx, "B3"),
    B4: buildB(ctx, "B4"),
    C1: c1,
    C2: c2,
    C4: buildC4(ctx, cc),
    C5: buildC5(ctx, cc),
    C6: buildC6(ctx, cc, c1, c2),
    D1: buildD1(ctx),
    D5: buildD5(ctx),
    D6: buildD6(ctx),
    D7: buildD7(ctx),
    E1: buildE1(ctx),
    E2: buildE2(ctx),
    E3: buildE3(ctx),
    E4: buildE4(ctx, cc),
  };

  return { state: "ready", filter, coverage, metrics };
}
