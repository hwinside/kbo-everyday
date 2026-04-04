import { NextRequest, NextResponse } from "next/server";
import playersRoster from "@/lib/constants/players-roster.json";
import batterStats2025 from "@/lib/constants/stats-2025-batters.json";
import pitcherStats2025 from "@/lib/constants/stats-2025-pitchers.json";
import batterStats2026 from "@/lib/constants/stats-2026-batters.json";
import pitcherStats2026 from "@/lib/constants/stats-2026-pitchers.json";
import type { RosterPlayer } from "@/types/api";

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

async function fetchBatterStats(): Promise<PlayerStat[]> {
  // Basic1: 순위(0) 선수명(1) 팀명(2) AVG(3) G(4) PA(5) AB(6) R(7) H(8) 2B(9) 3B(10) HR(11) TB(12) RBI(13) SAC(14) SF(15)
  const url = `${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=HRA_RT`;
  const html = await fetchHtml(url);
  const rows = parseTable(html);
  const roster = playersRoster as RosterPlayer[];
  return rows.map((c, i) => {
    const name = c[1] || "";
    const found = roster.find((p) => p.name === name);
    return {
      rank: i + 1,
      name,
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
      tb: parseInt(c[12]) || 0,
      rbi: parseInt(c[13]) || 0,
      sac: parseInt(c[14]) || 0,
      sf: parseInt(c[15]) || 0,
      kboId: found?.kboId || "",
      playerId: found?.kboId || "",
    };
  });
}

async function fetchPitcherStats(): Promise<PlayerStat[]> {
  // 순위(0) 선수명(1) 팀명(2) ERA(3) G(4) W(5) L(6) SV(7) HLD(8) WPCT(9) IP(10) H(11) HR(12) BB(13) HBP(14) SO(15) R(16) ER(17) WHIP(18)
  const url = `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=ERA_RT`;
  const html = await fetchHtml(url);
  const rows = parseTable(html);
  const roster = playersRoster as RosterPlayer[];
  return rows.map((c, i) => {
    const name = c[1] || "";
    const found = roster.find((p) => p.name === name);
    return {
      rank: i + 1,
      name,
      team: c[2] || "",
      era: c[3] || "0.00",
      games: parseInt(c[4]) || 0,
      wins: parseInt(c[5]) || 0,
      losses: parseInt(c[6]) || 0,
      saves: parseInt(c[7]) || 0,
      holds: parseInt(c[8]) || 0,
      wpct: c[9] || "0.000",
      ip: c[10] || "0",
      h: parseInt(c[11]) || 0,
      hr: parseInt(c[12]) || 0,
      bb: parseInt(c[13]) || 0,
      hbp: parseInt(c[14]) || 0,
      so: parseInt(c[15]) || 0,
      r: parseInt(c[16]) || 0,
      er: parseInt(c[17]) || 0,
      whip: c[18] || "0.00",
      kboId: found?.kboId || "",
      playerId: found?.kboId || "",
    };
  });
}

interface StatsResult {
  stats: PlayerStat[];
  type: string;
  count: number;
}

const cache: Record<string, { data: StatsResult; ts: number }> = {};
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key: string) {
  const entry = cache[key];
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}
function setCache(key: string, data: StatsResult) {
  cache[key] = { data, ts: Date.now() };
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") || "batter";
  const season = req.nextUrl.searchParams.get("season") || "current";

  // 2026 시즌 — static data
  if (season === "2026") {
    const stats = type === "pitcher"
      ? (pitcherStats2026 as unknown as PlayerStat[])
      : (batterStats2026 as unknown as PlayerStat[]);
    return NextResponse.json({ stats, type, count: stats.length, season: 2026 });
  }

  // 2025 시즌 — static full data (300 batters + 277 pitchers)
  if (season === "2025") {
    const stats = type === "pitcher"
      ? (pitcherStats2025 as unknown as PlayerStat[])
      : (batterStats2025 as unknown as PlayerStat[]);
    return NextResponse.json({ stats, type, count: stats.length, season: 2025 });
  }

  // Current season — live crawl (top 30)
  const cacheKey = `stats-${type}`;
  const cached = getCached(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const stats = type === "pitcher" ? await fetchPitcherStats() : await fetchBatterStats();
    const result = { stats, type, count: stats.length };
    setCache(cacheKey, result);
    return NextResponse.json(result);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message, stats: [] }, { status: 500 });
  }
}
