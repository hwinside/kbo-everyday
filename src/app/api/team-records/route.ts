import { NextRequest, NextResponse } from "next/server";
import { TEAMS } from "@/lib/constants/teams";

const KBO_BASE = "https://www.koreabaseball.com";

// in-memory cache
interface RecordsCache {
  data: TeamRecordsResponse;
  expiresAt: number;
}
let cache: RecordsCache | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface TeamBatting {
  teamId: number;
  slug: string;
  avg: string;
  ops: string;
  hr: number;
  runs: number;
  sb: number;
}

interface TeamPitching {
  teamId: number;
  slug: string;
  era: string;
  whip: string;
  so: number;
  sv: number;
  hra: number;
}

interface TeamRecordsResponse {
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
    if (name) opsMap.set(name, row[11] ?? "0");
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

export async function GET(req: NextRequest) {
  const seasonParam = req.nextUrl.searchParams.get("season") ?? "2026";
  const season = parseInt(seasonParam, 10);

  if (cache && cache.expiresAt > Date.now()) {
    return NextResponse.json(cache.data, {
      headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200" },
    });
  }

  try {
    const [batting, pitching] = await Promise.all([
      fetchBattingRecords(),
      fetchPitchingRecords(),
    ]);

    const data: TeamRecordsResponse = { season, batting, pitching };
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
