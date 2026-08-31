import { NextRequest, NextResponse } from "next/server";
import { TEAMS } from "@/lib/constants/teams";

const KBO_BASE = "https://www.koreabaseball.com";
const NAVER_STATS_BASE =
  "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons";
const TOTAL_DEADLINE_MS = 3_500;
const KBO_SUB_BUDGET_MS = 1_500;

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
  games?: number;
  ab?: number;
  hits?: number;
}

export interface TeamPitching {
  teamId: number;
  slug: string;
  era: string;
  whip: string;
  so: number;
  sv: number;
  hra: number;
  games?: number;
  inningsOuts?: number;
  er?: number;
  hitsAllowed?: number;
}

/** upstream 에서 조립한 원자료 — 아직 수신시각이 붙지 않은 상태. */
export interface TeamRecordsData {
  season: number;
  batting: TeamBatting[];
  pitching: TeamPitching[];
}

export interface TeamRecordsResponse extends TeamRecordsData {
  /**
   * 이 데이터를 **upstream(KBO/Naver)에서 실제로 받은** 시각(ISO).
   *
   * 🔴 왜 필요한가 (삼순 2026-08-28 P0-③): 아래 fail-soft 경로는 upstream 이 죽으면
   *   **만료된 메모리 캐시를 그대로 200 으로** 돌려준다. 소비자가 "응답을 받은 시각"을
   *   신선도로 쓰면 몇 시간 묵은 값을 방금 값으로 오인한다 — 200 은 신선도의 증거가 아니다.
   *   그래서 신선도를 **데이터에 결속**해서 내보낸다(M90 `값과 provenance 는 별도 축`).
   */
  fetchedAt: string;
}

async function withinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadlineAt: number,
  label: string,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error(`${label} deadline exceeded`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error(`${label} deadline exceeded`)),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(
  url: string,
  deadlineAt: number,
  fetchImpl: typeof fetch,
): Promise<string> {
  return withinDeadline(
    async (signal) => {
      const res = await fetchImpl(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: KBO_BASE,
        },
        signal,
        next: { revalidate: 0 },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return res.text();
    },
    deadlineAt,
    "KBO team records",
  );
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

export function parseKboInningsOuts(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d+)(?:[ .]([012])(?:\/3)?)?$/);
  if (!match) return null;
  return Number(match[1]) * 3 + Number(match[2] ?? 0);
}

/** KBO team name → app TeamData via shortName or name matching */
function findTeamByKboName(kboName: string) {
  return TEAMS.find(
    (t) =>
      t.shortName === kboName ||
      t.name === kboName ||
      t.name.includes(kboName) ||
      kboName.includes(t.shortName),
  );
}

function requireTeamRows(
  rows: string[][],
  source: string,
  requiredIndexes: number[],
): Map<number, string[]> {
  const byTeam = new Map<number, string[]>();
  for (const row of rows) {
    const team = findTeamByKboName(row[1]?.trim() ?? "");
    if (
      !team ||
      byTeam.has(team.id) ||
      requiredIndexes.some((index) => {
        const value = row[index]?.trim();
        return (
          value === undefined || value === "" || !Number.isFinite(Number(value))
        );
      })
    ) {
      throw new Error(
        `KBO ${source} contains incomplete or duplicate team data`,
      );
    }
    byTeam.set(team.id, row);
  }
  if (byTeam.size !== TEAMS.length) {
    throw new Error(`KBO ${source} team coverage invalid: ${byTeam.size}`);
  }
  return byTeam;
}

async function fetchBattingRecords(
  deadlineAt: number,
  fetchImpl: typeof fetch,
): Promise<TeamBatting[]> {
  // Basic1 실제 컬럼: 순위(0) 팀명(1) AVG(2) G(3) PA(4) AB(5) R(6) H(7) 2B(8) 3B(9) HR(10) TB(11) RBI(12) SAC(13) SF(14)
  // OPS는 Basic2, SB는 Runner 페이지에서 조회
  const [basic1Html, basic2Html, runnerHtml] = await Promise.all([
    fetchHtml(
      `${KBO_BASE}/Record/Team/Hitter/Basic1.aspx`,
      deadlineAt,
      fetchImpl,
    ),
    fetchHtml(
      `${KBO_BASE}/Record/Team/Hitter/Basic2.aspx`,
      deadlineAt,
      fetchImpl,
    ),
    fetchHtml(
      `${KBO_BASE}/Record/Team/Runner/Basic.aspx`,
      deadlineAt,
      fetchImpl,
    ),
  ]);

  const basic1 = requireTeamRows(
    parseTable(basic1Html),
    "Hitter Basic1",
    [2, 3, 5, 6, 7, 10],
  );
  // Basic2 컬럼: 순위(0) 팀명(1) AVG(2) BB(3) IBB(4) HBP(5) SO(6) GDP(7) SLG(8) OBP(9) OPS(10)
  const basic2 = requireTeamRows(parseTable(basic2Html), "Hitter Basic2", [10]);
  const runner = requireTeamRows(parseTable(runnerHtml), "Runner Basic", [4]);

  const results: TeamBatting[] = [];
  for (const team of TEAMS) {
    const row = basic1.get(team.id)!;
    const basic2Row = basic2.get(team.id)!;
    const runnerRow = runner.get(team.id)!;
    results.push({
      teamId: team.id,
      slug: team.slug,
      avg: row[2],
      ops: basic2Row[10],
      hr: Number(row[10]),
      runs: Number(row[6]),
      sb: Number(runnerRow[4]),
      games: Number(row[3]),
      ab: Number(row[5]),
      hits: Number(row[7]),
    });
  }
  return results;
}

async function fetchPitchingRecords(
  deadlineAt: number,
  fetchImpl: typeof fetch,
): Promise<TeamPitching[]> {
  // Basic1 실제 컬럼: 순위(0) 팀명(1) ERA(2) G(3) W(4) L(5) SV(6) HLD(7) WPCT(8) IP(9) H(10) HR(11) BB(12) HBP(13) SO(14) R(15) ER(16) WHIP(17)
  const basic1Html = await fetchHtml(
    `${KBO_BASE}/Record/Team/Pitcher/Basic1.aspx`,
    deadlineAt,
    fetchImpl,
  );
  const basic1 = requireTeamRows(
    parseTable(basic1Html),
    "Pitcher Basic1",
    // IP(9)는 `857 1/3` 같은 KBO 정규 형식이라 generic Number 검증에서 제외한다.
    // 아래 parseKboInningsOuts가 전용 fail-close 검증을 담당한다.
    [2, 3, 10, 11, 14, 16, 17],
  );

  const results: TeamPitching[] = [];
  for (const team of TEAMS) {
    const row = basic1.get(team.id)!;
    const inningsOuts = parseKboInningsOuts(row[9]);
    if (inningsOuts === null) {
      throw new Error(`KBO Pitcher Basic1 innings invalid: ${row[9]}`);
    }
    results.push({
      teamId: team.id,
      slug: team.slug,
      era: row[2],
      whip: row[17],
      so: Number(row[14]),
      sv: Number(row[6]),
      hra: Number(row[11]),
      games: Number(row[3]),
      inningsOuts,
      er: Number(row[16]),
      hitsAllowed: Number(row[10]),
    });
  }
  return results;
}

export async function fetchKboTeamRecords(
  deadlineAt: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ batting: TeamBatting[]; pitching: TeamPitching[] }> {
  const kboDeadlineAt = Math.min(deadlineAt, Date.now() + KBO_SUB_BUDGET_MS);
  const [batting, pitching] = await Promise.all([
    fetchBattingRecords(kboDeadlineAt, fetchImpl),
    fetchPitchingRecords(kboDeadlineAt, fetchImpl),
  ]);
  return { batting, pitching };
}

interface NaverTeamStat {
  teamId?: string;
  teamName?: string;
  offenseHra?: number;
  offenseOps?: number;
  offenseHr?: number;
  offenseRun?: number;
  offenseSb?: number;
  offenseAb?: number;
  offenseHit?: number;
  defenseEra?: number;
  defenseWhip?: number;
  defenseKk?: number;
  defenseSave?: number;
  defenseHr?: number;
  defenseInning?: number;
  defenseEr?: number;
  defenseHit?: number;
  gameCount?: number;
}

function formatRate(
  value: number,
  digits: number,
  trimLeadingZero = false,
): string {
  const formatted = value.toFixed(digits);
  return trimLeadingZero ? formatted.replace(/^0(?=\.)/, "") : formatted;
}

/** Naver team-stat payload → 기존 /api/team-records 응답 계약. */
export function mapNaverTeamRecords(
  payload: unknown,
  season: number,
): TeamRecordsData {
  const rows = (
    payload as {
      success?: boolean;
      result?: { seasonTeamStats?: NaverTeamStat[] };
    }
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
      row.offenseAb,
      row.offenseHit,
      row.defenseEra,
      row.defenseWhip,
      row.defenseKk,
      row.defenseSave,
      row.defenseHr,
      row.defenseInning,
      row.defenseEr,
      row.defenseHit,
      row.gameCount,
    ];
    if (
      !team ||
      seen.has(teamId) ||
      numericValues.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("Naver team records contain incomplete team data");
    }
    const inningsOuts = parseKboInningsOuts(row.defenseInning);
    if (inningsOuts === null) {
      throw new Error("Naver team records contain invalid innings");
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
      games: row.gameCount as number,
      ab: row.offenseAb as number,
      hits: row.offenseHit as number,
    });
    pitching.push({
      teamId,
      slug: team.slug,
      era: formatRate(row.defenseEra as number, 2),
      whip: formatRate(row.defenseWhip as number, 2),
      so: row.defenseKk as number,
      sv: row.defenseSave as number,
      hra: row.defenseHr as number,
      games: row.gameCount as number,
      inningsOuts,
      er: row.defenseEr as number,
      hitsAllowed: row.defenseHit as number,
    });
  }

  return { season, batting, pitching };
}

export async function fetchNaverTeamRecords(
  season: number,
  deadlineAt: number = Date.now() + TOTAL_DEADLINE_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<TeamRecordsData> {
  return withinDeadline(
    async (signal) => {
      const res = await fetchImpl(
        `${NAVER_STATS_BASE}/${season}/teams?gameType=REGULAR_SEASON`,
        {
          headers: {
            Referer: "https://sports.news.naver.com/",
            "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
          },
          signal,
          cache: "no-store",
        },
      );
      if (!res.ok) throw new Error(`Naver team records HTTP ${res.status}`);
      return mapNaverTeamRecords(await res.json(), season);
    },
    deadlineAt,
    "Naver team records",
  );
}

/** KBO HTML primary → Naver team statistics failover. partial/dual-fail은 fail-close. */
export async function loadTeamRecords(
  season: number,
  kboImpl: (
    deadlineAt: number,
  ) => Promise<{
    batting: TeamBatting[];
    pitching: TeamPitching[];
  }> = fetchKboTeamRecords,
  naverImpl: (
    year: number,
    deadlineAt: number,
  ) => Promise<TeamRecordsData> = fetchNaverTeamRecords,
): Promise<TeamRecordsData> {
  const deadlineAt = Date.now() + TOTAL_DEADLINE_MS;
  try {
    const { batting, pitching } = await kboImpl(deadlineAt);
    if (
      batting.length !== TEAMS.length ||
      pitching.length !== TEAMS.length ||
      new Set(batting.map((row) => row.teamId)).size !== TEAMS.length ||
      new Set(pitching.map((row) => row.teamId)).size !== TEAMS.length
    ) {
      throw new Error(
        `KBO team records partial: batting=${batting.length}, pitching=${pitching.length}`,
      );
    }
    return { season, batting, pitching };
  } catch (error) {
    console.warn(
      "[team-records] KBO failed, using Naver:",
      (error as Error).message,
    );
    return naverImpl(season, deadlineAt);
  }
}

export async function loadCachedTeamRecords(
  season: number,
): Promise<TeamRecordsResponse> {
  if (cache && cache.data.season === season && cache.expiresAt > Date.now()) {
    return cache.data;
  }
  const loaded = await loadTeamRecords(season);
  // fetchedAt 은 **upstream 응답을 받은 그 시각**에 한 번만 찍고 캐시에 함께 저장한다.
  // 캐시 히트마다 갱신하면 "우리가 응답한 시각"이 되어 신선도 의미가 사라진다.
  const data: TeamRecordsResponse = { ...loaded, fetchedAt: new Date().toISOString() };
  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

export async function GET(req: NextRequest) {
  const seasonParam = req.nextUrl.searchParams.get("season") ?? "2026";
  const season = parseInt(seasonParam, 10);

  if (cache && cache.data.season === season && cache.expiresAt > Date.now()) {
    return NextResponse.json(cache.data, {
      headers: {
        "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200",
      },
    });
  }

  try {
    const data = await loadCachedTeamRecords(season);

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200",
      },
    });
  } catch (e: unknown) {
    // Fail soft: return cached stale data if available, else 500
    if (cache?.data.season === season) {
      return NextResponse.json(cache.data, {
        headers: { "Cache-Control": "public, s-maxage=60" },
      });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
