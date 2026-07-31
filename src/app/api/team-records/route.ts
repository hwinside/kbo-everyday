import { NextRequest, NextResponse } from "next/server";
import { TEAMS } from "@/lib/constants/teams";

const KBO_BASE = "https://www.koreabaseball.com";
const NAVER_STATS_BASE = "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons";
const FETCH_TIMEOUT_MS = 5_000;

// in-memory cache
interface RecordsCache {
  data: TeamRecordsResponse;
  expiresAt: number;
}
let cache: RecordsCache | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface TeamBatting {
  teamId: number;
  slug: string;
  avg: string;
  ops: string;
  hr: number;
  runs: number;
  sb: number;
}

export interface TeamPitching {
  teamId: number;
  slug: string;
  era: string;
  whip: string;
  so: number;
  sv: number;
  hra: number;
}

export interface TeamRecordsResponse {
  season: number;
  batting: TeamBatting[];
  pitching: TeamPitching[];
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: KBO_BASE,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

function parseTable(html: string): string[][] {
  const rows: string[][] = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return rows;
  const trMatches = tbodyMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!trMatches) return rows;
  for (const tr of trMatches) {
    const tdMatches = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (!tdMatches) continue;
    const cells = tdMatches.map((td) => td.replace(/<[^>]+>/g, "").trim());
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** KBO team name → app TeamData via shortName or name matching */
function findTeamByKboName(kboName: string) {
  return TEAMS.find(
    (t) =>
      t.shortName === kboName ||
      t.name === kboName ||
      t.name.includes(kboName) ||
      kboName.includes(t.shortName)
  );
}

async function fetchBattingRecords(): Promise<TeamBatting[]> {
  // Basic1 실제 컬럼: 순위(0) 팀명(1) AVG(2) G(3) PA(4) AB(5) R(6) H(7) 2B(8) 3B(9) HR(10) TB(11) RBI(12) SAC(13) SF(14)
  // OPS는 Basic2, SB는 Runner 페이지에서 조회
  const [basic1Html, basic2Html, runnerHtml] = await Promise.all([
    fetchHtml(`${KBO_BASE}/Record/Team/Hitter/Basic1.aspx`),
    fetchHtml(`${KBO_BASE}/Record/Team/Hitter/Basic2.aspx`),
    fetchHtml(`${KBO_BASE}/Record/Team/Runner/Basic.aspx`),
  ]);

  const basic1 = parseTable(basic1Html);
  const basic2 = parseTable(basic2Html);
  const runner = parseTable(runnerHtml);

  const opsMap = new Map<string, string>();
  for (const row of basic2) {
    const name = row[1]?.trim();
    // Basic2 컬럼: 순위(0) 팀명(1) AVG(2) BB(3) IBB(4) HBP(5) SO(6) GDP(7) SLG(8) OBP(9) OPS(10)
    if (name) opsMap.set(name, row[10] ?? "0");
  }

  const sbMap = new Map<string, number>();
  for (const row of runner) {
    const name = row[1]?.trim();
    if (name) sbMap.set(name, parseInt(row[4] ?? "0", 10) || 0);
  }

  const results: TeamBatting[] = [];
  for (const row of basic1) {
    const kboName = row[1]?.trim();
    if (!kboName) continue;
    const team = findTeamByKboName(kboName);
    if (!team) continue;

    results.push({
      teamId: team.id,
      slug: team.slug,
      avg: row[2] ?? ".000",
      ops: opsMap.get(kboName) ?? "0",
      hr: parseInt(row[10] ?? "0", 10) || 0,
      runs: parseInt(row[6] ?? "0", 10) || 0,
      sb: sbMap.get(kboName) ?? 0,
    });
  }
  return results;
}

async function fetchPitchingRecords(): Promise<TeamPitching[]> {
  // Basic1 실제 컬럼: 순위(0) 팀명(1) ERA(2) G(3) W(4) L(5) SV(6) HLD(7) WPCT(8) IP(9) H(10) HR(11) BB(12) HBP(13) SO(14) R(15) ER(16) WHIP(17)
  const basic1Html = await fetchHtml(`${KBO_BASE}/Record/Team/Pitcher/Basic1.aspx`);
  const basic1 = parseTable(basic1Html);

  const results: TeamPitching[] = [];
  for (const row of basic1) {
    const kboName = row[1]?.trim();
    if (!kboName) continue;
    const team = findTeamByKboName(kboName);
    if (!team) continue;

    results.push({
      teamId: team.id,
      slug: team.slug,
      era: row[2] ?? "0.00",
      whip: row[17] ?? "0.00",
      so: parseInt(row[14] ?? "0", 10) || 0,
      sv: parseInt(row[6] ?? "0", 10) || 0,
      hra: parseInt(row[11] ?? "0", 10) || 0,
    });
  }
  return results;
}

interface NaverTeamStat {
  teamId?: string;
  teamName?: string;
  offenseHra?: number;
  offenseOps?: number;
  offenseHr?: number;
  offenseRun?: number;
  offenseSb?: number;
  defenseEra?: number;
  defenseWhip?: number;
  defenseKk?: number;
  defenseSave?: number;
  defenseHr?: number;
}

function formatRate(value: number, digits: number, trimLeadingZero = false): string {
  const formatted = value.toFixed(digits);
  return trimLeadingZero ? formatted.replace(/^0(?=\.)/, "") : formatted;
}

/** Naver team-stat payload → 기존 /api/team-records 응답 계약. */
export function mapNaverTeamRecords(payload: unknown, season: number): TeamRecordsResponse {
  const rows = (
    payload as { success?: boolean; result?: { seasonTeamStats?: NaverTeamStat[] } }
  )?.result?.seasonTeamStats;
  if (
    (payload as { success?: boolean })?.success !== true ||
    !Array.isArray(rows) ||
    rows.length !== TEAMS.length
  ) {
    throw new Error("Naver team records schema invalid");
  }

  const batting: TeamBatting[] = [];
  const pitching: TeamPitching[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    const team = findTeamByKboName(row.teamName ?? "");
    const teamId = team?.id ?? 0;
    const numericValues = [
      row.offenseHra,
      row.offenseOps,
      row.offenseHr,
      row.offenseRun,
      row.offenseSb,
      row.defenseEra,
      row.defenseWhip,
      row.defenseKk,
      row.defenseSave,
      row.defenseHr,
    ];
    if (!team || seen.has(teamId) || numericValues.some((value) => !Number.isFinite(value))) {
      throw new Error("Naver team records contain incomplete team data");
    }
    seen.add(teamId);
    batting.push({
      teamId,
      slug: team.slug,
      avg: formatRate(row.offenseHra as number, 3, true),
      ops: formatRate(row.offenseOps as number, 3),
      hr: row.offenseHr as number,
      runs: row.offenseRun as number,
      sb: row.offenseSb as number,
    });
    pitching.push({
      teamId,
      slug: team.slug,
      era: formatRate(row.defenseEra as number, 2),
      whip: formatRate(row.defenseWhip as number, 2),
      so: row.defenseKk as number,
      sv: row.defenseSave as number,
      hra: row.defenseHr as number,
    });
  }

  return { season, batting, pitching };
}

export async function fetchNaverTeamRecords(
  season: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TeamRecordsResponse> {
  const res = await fetchImpl(
    `${NAVER_STATS_BASE}/${season}/teams?gameType=REGULAR_SEASON`,
    {
      headers: {
        Referer: "https://sports.news.naver.com/",
        "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    },
  );
  if (!res.ok) throw new Error(`Naver team records HTTP ${res.status}`);
  return mapNaverTeamRecords(await res.json(), season);
}

/** KBO HTML primary → Naver team statistics failover. partial/dual-fail은 fail-close. */
export async function loadTeamRecords(
  season: number,
  kboImpl: () => Promise<{ batting: TeamBatting[]; pitching: TeamPitching[] }> = async () => {
    const [batting, pitching] = await Promise.all([
      fetchBattingRecords(),
      fetchPitchingRecords(),
    ]);
    return { batting, pitching };
  },
  naverImpl: (year: number) => Promise<TeamRecordsResponse> = fetchNaverTeamRecords,
): Promise<TeamRecordsResponse> {
  try {
    const { batting, pitching } = await kboImpl();
    if (batting.length !== TEAMS.length || pitching.length !== TEAMS.length) {
      throw new Error(`KBO team records partial: batting=${batting.length}, pitching=${pitching.length}`);
    }
    return { season, batting, pitching };
  } catch (error) {
    console.warn("[team-records] KBO failed, using Naver:", (error as Error).message);
    return naverImpl(season);
  }
}

export async function GET(req: NextRequest) {
  const seasonParam = req.nextUrl.searchParams.get("season") ?? "2026";
  const season = parseInt(seasonParam, 10);

  if (cache && cache.expiresAt > Date.now()) {
    return NextResponse.json(cache.data, {
      headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200" },
    });
  }

  try {
    const data = await loadTeamRecords(season);
    cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };

    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200" },
    });
  } catch (e: unknown) {
    // Fail soft: return cached stale data if available, else 500
    if (cache) {
      return NextResponse.json(cache.data, {
        headers: { "Cache-Control": "public, s-maxage=60" },
      });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
