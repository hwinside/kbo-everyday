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
    next: { revalidate: 0 },  // 캐싱은 인메모리 캐시에서 관리 (getCacheTtl)
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

function parsePitcherRow(c: string[], roster: RosterPlayer[]): PlayerStat {
  const name = c[1] || "";
  const found = roster.find((p) => p.name === name);
  return {
    rank: 0,
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
}

async function fetchPitcherStats(): Promise<PlayerStat[]> {
  // ERA_RT는 규정이닝 투수만 반환 (시즌초 17명 등), SV/HOLD/W/KK는 전체 30명
  // 여러 정렬로 크롤링 후 병합해야 세이브/홀드 리더가 빠지지 않음
  const sortKeys = ["ERA_RT", "SV_CN", "HOLD_CN", "W_CN", "KK_CN"];
  const roster = playersRoster as RosterPlayer[];
  const merged = new Map<string, PlayerStat>(); // key: name+team

  const results = await Promise.all(
    sortKeys.map(async (sort) => {
      const url = `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=${sort}`;
      const html = await fetchHtml(url);
      return parseTable(html);
    })
  );

  for (const rows of results) {
    for (const c of rows) {
      const name = c[1] || "";
      const team = c[2] || "";
      const key = `${name}::${team}`;
      if (!merged.has(key)) {
        merged.set(key, parsePitcherRow(c, roster));
      }
    }
  }

  // ERA 기준 정렬 후 순위 부여
  const stats = [...merged.values()]
    .sort((a, b) => Number(a.era || 99) - Number(b.era || 99));
  stats.forEach((p, i) => { p.rank = i + 1; });
  return stats;
}

interface StatsResult {
  stats: PlayerStat[];
  type: string;
  count: number;
  source?: string;
}

const cache: Record<string, { data: StatsResult; ts: number }> = {};

// 경기시간대(KST 11~24시) 10분, 그 외 1시간 — 더블헤더/주말 조기경기 대응
function getCacheTtl(): number {
  const kstHour = new Date(Date.now() + 9 * 3600_000).getUTCHours();
  return kstHour >= 11 && kstHour < 24 ? 10 * 60 * 1000 : 60 * 60 * 1000;
}

function getCached(key: string) {
  const entry = cache[key];
  if (entry && Date.now() - entry.ts < getCacheTtl()) return entry.data;
  return null;
}
function setCache(key: string, data: StatsResult) {
  cache[key] = { data, ts: Date.now() };
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") || "batter";
  const season = req.nextUrl.searchParams.get("season") || "current";

  // 2025 시즌 — 확정 static data (300 batters + 277 pitchers)
  if (season === "2025") {
    const stats = type === "pitcher"
      ? (pitcherStats2025 as unknown as PlayerStat[])
      : (batterStats2025 as unknown as PlayerStat[]);
    return NextResponse.json({ stats, type, count: stats.length, season: 2025 });
  }

  // 2026 시즌 + current — 라이브 크롤링 (캐시: 경기시간대 10분 / 평시 1시간)
  const cacheKey = `stats-${type}-${season}`;
  const cached = getCached(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const stats = type === "pitcher" ? await fetchPitcherStats() : await fetchBatterStats();
    const result: StatsResult = { stats, type, count: stats.length, source: "live" };
    setCache(cacheKey, result);
    return NextResponse.json(result);
  } catch (e: unknown) {
    // 크롤링 실패 시 static JSON fallback (빈화면 방지)
    if (season === "2026") {
      const fallback = type === "pitcher"
        ? (pitcherStats2026 as unknown as PlayerStat[])
        : (batterStats2026 as unknown as PlayerStat[]);
      return NextResponse.json({ stats: fallback, type, count: fallback.length, season: 2026, source: "fallback" });
    }
    return NextResponse.json({ error: (e as Error).message, stats: [] }, { status: 500 });
  }
}
