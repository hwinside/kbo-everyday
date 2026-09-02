import {
  createCareerRecordFetcher,
  type CareerRecord,
  type CareerRecordFetcher,
} from "@/lib/baseball-qa/stats/career-series";
import { resolvePlayer, resolveUniquePlayerByName } from "@/lib/utils/resolve-player";

/**
 * 선수 페이지 "통산" 뷰용 서비스.
 *
 * 야잘알봇이 쓰는 KBO 공식 연도/통산 파서(`career-series.ts`)의 **HTML 파서를 재사용**한다.
 * 새 수집 경로를 만들지 않는다 — 같은 `Total.aspx` 통산 행/연도 행을 읽어 선수 페이지가
 * 쓰는 정규화 키(realStats 와 동일 shape)로만 매핑한다. 계산·추정 없음, 결측이면 fail-close.
 *
 * ⚠️ 봇용 `CAREER_METRIC_COLUMNS` 는 재사용하지 않는다(삼순 #1334 ②): 봇은 파생 계산
 * 가능성 때문에 BB/SLG/OBP·CG/SHO 를 배제했지만, 이 값들은 Total.aspx 통산행에 **원값으로
 * 실재**하고 시즌 UI 가 이미 노출한다. UI 전용 공식 컬럼 allowlist(`CAREER_UI_COLUMNS`)로
 * 원값만 서빙한다.
 *
 * ⚠️ identity(삼순 #1334 ①): 대상 선수는 서버 roster SSOT 로 정하고, KBO record.playerName 이
 * 그 선수인지 대조한다. 외국인은 roster 풀네임(`라클란 웰스`)과 KBO 등록명(`웰스`)이 달라
 * 정확 일치로는 전부 fail-close 되므로, roster 이름과의 **부분 포함**(prefix/suffix) 또는
 * 이름→유니크 resolve 의 numericId 일치로 판정한다.
 */

export type CareerStatsTable = "batter" | "pitcher";

/**
 * UI 전용 공식 컬럼 allowlist — KBO Total.aspx 헤더명(값) 그대로.
 * 시즌 UI 공통 지표(볼넷·완투·완봉·출루율·장타율)를 포함한다. 파생 계산 없음(원값만).
 * OPS 는 통산행에 컬럼이 없어(OBP·SLG 만 존재) 넣지 않는다 — 계산으로 만들지 않는다.
 */
export const CAREER_UI_COLUMNS: Readonly<Record<CareerStatsTable, Readonly<Record<string, string>>>> = {
  batter: {
    avg: "AVG", games: "G", ab: "AB", runs: "R", hits: "H",
    doubles: "2B", triples: "3B", hr: "HR", tb: "TB", rbi: "RBI",
    sb: "SB", cs: "CS", bb: "BB", hbp: "HBP", so: "SO", gdp: "GDP",
    slg: "SLG", obp: "OBP",
  },
  pitcher: {
    era: "ERA", games: "G", cg: "CG", sho: "SHO", wins: "W", losses: "L",
    saves: "SV", holds: "HLD", wpct: "WPCT", ip: "IP", h: "H", hr: "HR",
    bb: "BB", hbp: "HBP", so: "SO", r: "R", er: "ER", whip: "WHIP",
  },
};

/** 통산 누적 값 — 키는 선수 페이지 realStats 와 동일(문자열 원값 그대로). */
export type PlayerCareerStats = Record<string, string> & { seasons?: string };

/** 연도별 한 행 — 그 해 소속 + 정규화 지표 원값. */
export interface CareerSeasonRow {
  year: number;
  team: string;
  values: Record<string, string>;
}

/** 소속 이력 한 구간(연속 동일 팀). */
export interface CareerTeamSpan {
  team: string;
  from: number;
  to: number;
}

export interface PlayerCareerPayload {
  totals: PlayerCareerStats | null;
  series: CareerSeasonRow[];
  teams: CareerTeamSpan[];
}

const KBO_FIRST_SEASON = 1982;

function mapColumns(source: Record<string, string>, table: CareerStatsTable): Record<string, string> {
  const columns = CAREER_UI_COLUMNS[table];
  const out: Record<string, string> = {};
  for (const [key, column] of Object.entries(columns)) {
    const value = source[column];
    if (value === undefined || value === "-") continue;
    out[key] = value;
  }
  return out;
}

function normalizeName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** 이름→유니크 resolve 주입 타입(테스트 대체용). */
export type UniqueNameResolver = (name: string) => { numericId: string } | null;

/**
 * KBO record.playerName 이 rawId 의 대상 선수인지 판정한다.
 *
 * ① 정확 일치 ② roster 풀네임 ↔ KBO 등록명 부분 포함(외국인: `웰스`⊂`라클란 웰스`,
 * `스기모토`⊂`스기모토 고우키`) ③ 이름→유니크 resolve 의 numericId 일치.
 * 셋 중 하나도 성립 안 하면 false → 호출부가 fail-close.
 */
export function recordIdentityMatches(
  recordName: string,
  rawId: string,
  expectedName: string,
  resolveUnique: UniqueNameResolver = resolveUniquePlayerByName,
): boolean {
  const rec = normalizeName(recordName);
  const exp = normalizeName(expectedName);
  if (rec.length >= 2 && exp.length >= 2 && (rec === exp || exp.includes(rec) || rec.includes(exp))) {
    return true;
  }
  const u = resolveUnique(recordName);
  return u != null && String(u.numericId) === String(rawId);
}

/**
 * CareerRecord → 통산/연도/소속 payload. 통산행·연도행이 모두 없으면 null.
 * identity 대조는 호출부(getPlayerCareerResult)가 수행한다 — 여기선 순수 매핑만.
 */
export function mapCareerRecord(record: CareerRecord, table: CareerStatsTable): PlayerCareerPayload | null {
  let totals: PlayerCareerStats | null = null;
  if (record.career) {
    const mapped = mapColumns(record.career, table);
    if (Object.keys(mapped).length > 0) {
      totals = mapped as PlayerCareerStats;
      const years = record.rows.map((r) => r.year).filter((y) => y >= KBO_FIRST_SEASON);
      if (years.length > 0) totals.seasons = `${Math.min(...years)}~${Math.max(...years)}`;
    }
  }

  const series: CareerSeasonRow[] = record.rows
    .filter((r) => r.year >= KBO_FIRST_SEASON)
    .map((r) => ({ year: r.year, team: r.team, values: mapColumns(r.values, table) }));

  const teams: CareerTeamSpan[] = [];
  for (const row of series) {
    const last = teams[teams.length - 1];
    if (last && last.team === row.team) last.to = row.year;
    else teams.push({ team: row.team, from: row.year, to: row.year });
  }

  if (!totals && series.length === 0) return null;
  return { totals, series, teams };
}

/** kboId → 대상 선수의 정본 이름(roster SSOT). 없으면 null. */
export function resolveExpectedPlayerName(rawId: string): string | null {
  return resolvePlayer(rawId)?.name ?? null;
}

export interface CareerServiceDeps {
  fetcher?: CareerRecordFetcher;
  resolveName?: (rawId: string) => string | null;
  resolveUnique?: UniqueNameResolver;
}

const cache: Record<string, { data: PlayerCareerPayload | null; ts: number }> = {};
const CACHE_TTL_MS = 3_600_000;

/**
 * 라우트 진입점. rawId(=KBO playerId, 숫자) + pos 만 받는다.
 * 대상 선수명은 서버 roster 에서 정하고(클라 입력 미신뢰), KBO 응답이 그 선수인지 대조한다.
 * roster 미해석 → 404, KBO 응답이 다른 선수 → payload null(오매핑 노출 차단).
 */
export async function getPlayerCareerResult(
  rawId: string | null,
  pos = "타자",
  deps: CareerServiceDeps = {},
): Promise<{
  body: { payload?: PlayerCareerPayload | null; cached?: boolean; error?: string };
  status?: number;
  headers?: HeadersInit;
}> {
  if (!rawId || !/^\d+$/.test(rawId)) {
    return { body: { error: "numeric id required" }, status: 400, headers: { "Cache-Control": "no-store" } };
  }
  const resolveName = deps.resolveName ?? resolveExpectedPlayerName;
  const expectedName = resolveName(rawId);
  if (!expectedName) {
    return { body: { payload: null, error: "unknown player" }, status: 404, headers: { "Cache-Control": "no-store" } };
  }

  const table: CareerStatsTable = pos === "투수" ? "pitcher" : "batter";
  const cacheKey = `career-${rawId}-${table}-${normalizeName(expectedName)}`;
  const okHeaders = { "Cache-Control": "public, s-maxage=300" } as const;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { body: { payload: cached.data, cached: true }, headers: okHeaders };
  }
  try {
    const fetcher = deps.fetcher ?? createCareerRecordFetcher();
    const record = await fetcher(table, rawId);
    let payload: PlayerCareerPayload | null = null;
    if (record && recordIdentityMatches(record.playerName, rawId, expectedName, deps.resolveUnique)) {
      payload = mapCareerRecord(record, table);
    }
    cache[cacheKey] = { data: payload, ts: Date.now() };
    return { body: { payload, cached: false }, headers: okHeaders };
  } catch (e: unknown) {
    return { body: { error: (e as Error).message, payload: null }, status: 500, headers: { "Cache-Control": "no-store" } };
  }
}
