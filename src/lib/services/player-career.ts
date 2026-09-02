import {
  createCareerRecordFetcher,
  CAREER_METRIC_COLUMNS,
  type CareerRecord,
} from "@/lib/baseball-qa/stats/career-series";

/**
 * 선수 페이지 "통산" 뷰용 서비스.
 *
 * 야잘알봇이 쓰는 KBO 공식 연도/통산 파서(`career-series.ts`)를 **그대로 재사용**한다.
 * 새 수집 경로를 만들지 않는다 — 같은 `Total.aspx` 통산 행을 읽어 선수 페이지가 쓰는
 * 정규화 키(realStats 와 동일 shape)로만 매핑한다. 계산·추정 없음, 결측이면 fail-close(null).
 */

export type CareerStatsTable = "batter" | "pitcher";

/** 통산 값 정규화 결과 — 키는 선수 페이지 realStats 와 동일(문자열 원값 그대로). */
export type PlayerCareerStats = Record<string, string> & {
  /** 통산 표기 소속(마지막 소속 아님) — 통산 행엔 팀명이 없어 undefined 가능. */
  seasons?: string;
};

const KBO_FIRST_SEASON = 1982;

/**
 * CareerRecord.career(공식 통산 행)를 정규화 키로 매핑한다.
 * CAREER_METRIC_COLUMNS 에 등재된 지표만 신뢰한다(파생·미검증 컬럼 배제).
 */
export function mapCareerTotals(
  record: CareerRecord,
  table: CareerStatsTable,
): PlayerCareerStats | null {
  const totals = record.career;
  if (!totals) return null;
  const columns = CAREER_METRIC_COLUMNS[table];
  const out: PlayerCareerStats = {};
  let any = false;
  for (const [key, column] of Object.entries(columns)) {
    const value = totals[column];
    if (value === undefined || value === "-") continue;
    out[key] = value;
    any = true;
  }
  if (!any) return null;
  // 통산이 걸친 시즌 범위(첫 시즌~마지막 시즌) — 헤더에 부가 표기.
  const years = record.rows.map((r) => r.year).filter((y) => y >= KBO_FIRST_SEASON);
  if (years.length > 0) {
    out.seasons = `${Math.min(...years)}~${Math.max(...years)}`;
  }
  return out;
}

const cache: Record<string, { data: PlayerCareerStats | null; ts: number }> = {};
const CACHE_TTL_MS = 3_600_000;

export async function getPlayerCareerResult(
  rawId: string | null,
  pos = "타자",
): Promise<{
  body: { stats?: PlayerCareerStats | null; cached?: boolean; error?: string };
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
    return { body: { stats: cached.data, cached: true }, headers: okHeaders };
  }
  try {
    const fetcher = createCareerRecordFetcher();
    const record = await fetcher(table, rawId);
    const stats = record ? mapCareerTotals(record, table) : null;
    cache[cacheKey] = { data: stats, ts: Date.now() };
    return { body: { stats, cached: false }, headers: okHeaders };
  } catch (e: unknown) {
    return {
      body: { error: (e as Error).message, stats: null },
      status: 500,
      headers: { "Cache-Control": "no-store" },
    };
  }
}
