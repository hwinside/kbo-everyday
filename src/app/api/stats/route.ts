import { NextRequest, NextResponse } from "next/server";

const KBO_BASE = "https://www.koreabaseball.com";

interface PlayerStat {
  rank: number;
  name: string;
  team: string;
  [key: string]: string | number;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": KBO_BASE,
    },
    next: { revalidate: 3600 },
  });
  return res.text();
}

function parseTable(html: string): string[][] {
  const rows: string[][] = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return rows;
  const tbody = tbodyMatch[1];
  const trMatches = tbody.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!trMatches) return rows;
  for (const tr of trMatches) {
    const cells: string[] = [];
    const tdMatches = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (tdMatches) {
      for (const td of tdMatches) {
        const text = td.replace(/<[^>]+>/g, "").trim();
        cells.push(text);
      }
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

// 타자 — Basic1: 순위,이름,팀,타율,경기,타석,타수,득점,안타,2루타,3루타,홈런,타점,도루,사사구?,삼진
async function fetchBatterStats(): Promise<PlayerStat[]> {
  const url = `${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=HRA_RT`;
  const html = await fetchHtml(url);
  const rows = parseTable(html);

  return rows.slice(0, 30).map((c, i) => ({
    rank: i + 1,
    name: c[1] || "",
    team: c[2] || "",
    avg: c[3] || ".000",
    games: parseInt(c[4]) || 0,
    pa: parseInt(c[5]) || 0,
    ab: parseInt(c[6]) || 0,
    runs: parseInt(c[7]) || 0,
    hits: parseInt(c[8]) || 0,
    doubles: parseInt(c[9]) || 0,
    triples: parseInt(c[10]) || 0,
    hr: parseInt(c[11]) || 0,
    rbi: parseInt(c[12]) || 0,
    sb: parseInt(c[13]) || 0,
  }));
}

// 투수 — Basic1: 순위,이름,팀,ERA,경기,완투,완봉,승,패,세,홀,승률,이닝,피안,피홈,볼넷,사구,삼진,실점,자책,WHIP
async function fetchPitcherStats(): Promise<PlayerStat[]> {
  const url = `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=ERA_RT`;
  const html = await fetchHtml(url);
  const rows = parseTable(html);

  return rows.slice(0, 30).map((c, i) => ({
    rank: i + 1,
    name: c[1] || "",
    team: c[2] || "",
    era: c[3] || "0.00",
    games: parseInt(c[4]) || 0,
    wins: parseInt(c[5]) || 0,
    losses: parseInt(c[6]) || 0,
    saves: parseInt(c[7]) || 0,
    holds: parseInt(c[8]) || 0,
    ip: c[10] || "0",
    so: parseInt(c[15]) || 0,
    er: parseInt(c[17]) || 0,
    whip: c[18] || "0.00",
  }));
}


// 인메모리 캐시 (5분)
const cache: Record<string, { data: any; ts: number }> = {};
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key: string) {
  const entry = cache[key];
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}
function setCache(key: string, data: any) {
  cache[key] = { data, ts: Date.now() };
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") || "batter";
  const cacheKey = `stats-${type}`;
  const cached = getCached(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const stats = type === "pitcher" ? await fetchPitcherStats() : await fetchBatterStats();
    const result = { stats, type, count: stats.length };
    setCache(cacheKey, result);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message, stats: [] }, { status: 500 });
  }
}
