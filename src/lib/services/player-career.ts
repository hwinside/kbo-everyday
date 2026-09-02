import {
  createCareerRecordFetcher,
  CAREER_METRIC_COLUMNS,
  type CareerRecord,
} from "@/lib/baseball-qa/stats/career-series";

/**
 * 선수 페이지 "통산" 뷰용 서비스.
 *
 * 야잘알봇이 쓰는 KBO 공식 연도/통산 파서(`career-series.ts`)를 **그대로 재사용**한다.
 * 새 수집 경로를 만들지 않는다 — 같은 `Total.aspx` 통산 행/연도 행을 읽어 선수 페이지가
 * 쓰는 정규화 키(realStats 와 동일 shape)로만 매핑한다. 계산·추정 없음, 결측이면 fail-close.
 */

export type CareerStatsTable = "batter" | "pitcher";

/** 통산 누적 값 — 키는 선수 페이지 realStats 와 동일(문자열 원값 그대로). */
export type PlayerCareerStats = Record<string, string> & {
  /** 통산이 걸친 시즌 범위(첫~마지막). */
  seasons?: string;
};

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
  /** 통산 누적 그리드용. 통산 행이 없으면 null. */
  totals: PlayerCareerStats | null;
  /** 연도별 추이(오름차순). 통산 행만 있고 연도 행이 없으면 빈 배열. */
  series: CareerSeasonRow[];
  /** 소속 이력(연도 행 파생). */
  teams: CareerTeamSpan[];
}

const KBO_FIRST_SEASON = 1982;

/** 공식 컬럼(값) → 정규화 키. CAREER_METRIC_COLUMNS 등재 지표만 신뢰(파생·미검증 배제). */
function mapColumns(
  source: Record<string, string>,
  table: CareerStatsTable,
): Record<string, string> {
  const columns = CAREER_METRIC_COLUMNS[table];
  const out: Record<string, string> = {};
  for (const [key, column] of Object.entries(columns)) {
    const value = source[column];
    if (value === undefined || value === "-") continue;
    out[key] = value;
  }
  return out;
}

/** CareerRecord → 통산/연도/소속 payload. 통산행·연도행이 모두 없으면 null. */
export function mapCareerRecord(
  record: CareerRecord,
  table: CareerStatsTable,
): PlayerCareerPayload | null {
  // 통산 누적
  let totals: PlayerCareerStats | null = null;
  if (record.career) {
    const mapped = mapColumns(record.career, table);
    if (Object.keys(mapped).length > 0) {
      totals = mapped as PlayerCareerStats;
      const years = record.rows.map((r) => r.year).filter((y) => y >= KBO_FIRST_SEASON);
      if (years.length > 0) totals.seasons = `${Math.min(...years)}~${Math.max(...years)}`;
    }
  }

  // 연도별 추이
  const series: CareerSeasonRow[] = record.rows
    .filter((r) => r.year >= KBO_FIRST_SEASON)
    .map((r) => ({ year: r.year, team: r.team, values: mapColumns(r.values, table) }));

  // 소속 이력 — 연속 동일 팀을 하나의 구간으로 압축.
  const teams: CareerTeamSpan[] = [];
  for (const row of series) {
    const last = teams[teams.length - 1];
    if (last && last.team === row.team) last.to = row.year;
    else teams.push({ team: row.team, from: row.year, to: row.year });
  }

  if (!totals && series.length === 0) return null;
  return { totals, series, teams };
}

const cache: Record<string, { data: PlayerCareerPayload | null; ts: number }> = {};
const CACHE_TTL_MS = 3_600_000;

export async function getPlayerCareerResult(
  rawId: string | null,
  pos = "타자",
): Promise<{
  body: { payload?: PlayerCareerPayload | null; cached?: boolean; error?: string };
  status?: number;
  headers?: HeadersInit;
}> {
  if (!rawId || !/^\d+$/.test(rawId)) {
    return { body: { error: "numeric id required" }, status: 400, headers: { "Cache-Control": "no-store" } };
  }
  const table: CareerStatsTable = pos === "투수" ? "pitcher" : "batter";
  const cacheKey = `career-${rawId}-${table}`;
  const okHeaders = { "Cache-Control": "public, s-maxage=300" } as const;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { body: { payload: cached.data, cached: true }, headers: okHeaders };
  }
  try {
    const fetcher = createCareerRecordFetcher();
    const record = await fetcher(table, rawId);
    const payload = record ? mapCareerRecord(record, table) : null;
    cache[cacheKey] = { data: payload, ts: Date.now() };
    return { body: { payload, cached: false }, headers: okHeaders };
  } catch (e: unknown) {
    return {
      body: { error: (e as Error).message, payload: null },
      status: 500,
      headers: { "Cache-Control": "no-store" },
    };
  }
}
