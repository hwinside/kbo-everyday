import { NextRequest, NextResponse } from "next/server";
import playersRoster from "@/lib/constants/players-roster.json";
import batterStats2025 from "@/lib/constants/stats-2025-batters.json";
import pitcherStats2025 from "@/lib/constants/stats-2025-pitchers.json";
import batterStats2026 from "@/lib/constants/stats-2026-batters.json";
import pitcherStats2026 from "@/lib/constants/stats-2026-pitchers.json";
import type { RosterPlayer } from "@/types/api";
import { resolvePlayer } from "@/lib/utils/resolve-player";

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
  // Basic2: 순위(0) 선수명(1) 팀명(2) AVG(3) BB(4) IBB(5) HBP(6) SO(7) GDP(8) SLG(9) OBP(10) OPS(11) MH(12) RISP(13) PH-BA(14)
  // Runner: 순위(0) 선수명(1) 팀명(2) G(3) SBA(4) SB(5) CS(6) SB%(7) OOB(8) PKO(9)
  // KBO 레코드는 페이지당 30행 + 포스트백 페이지네이션 → 단일 정렬로는 31위↓ 누락.
  // 카테고리별 정렬을 union해 각 부문 리더가 빠지지 않게 수집 (투수와 동일 패턴).
  // 비율스탯(*_RT) 리더보드는 KBO가 규정타석 충족자만 노출 → 규정타석 셋 산출에도 사용.
  const rateSorts = ["HRA_RT", "OPS_RT", "OBP_RT", "SLG_RT"];
  const basic1Sorts = ["GAME_CN", "HR_CN", "RBI_CN", "HIT_CN", "SB_CN", ...rateSorts];
  const basic2Sorts = ["GAME_CN", ...rateSorts];
  const roster = playersRoster as RosterPlayer[];

  const [basic1Htmls, basic2Htmls, runnerHtml] = await Promise.all([
    Promise.all(basic1Sorts.map((s) => fetchHtml(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=${s}`))),
    Promise.all(basic2Sorts.map((s) => fetchHtml(`${KBO_BASE}/Record/Player/HitterBasic/Basic2.aspx?sort=${s}`))),
    fetchHtml(`${KBO_BASE}/Record/Player/Runner/Basic.aspx?sort=SB_CN`),
  ]);

  // Basic1 union: name::team 최초 우선으로 병합 (각 정렬 상위 30 합집합)
  const mergedRows = new Map<string, string[]>();
  for (const html of basic1Htmls) {
    for (const c of parseTable(html)) {
      const key = `${(c[1] || "").trim()}::${(c[2] || "").trim()}`;
      if (key !== "::" && !mergedRows.has(key)) mergedRows.set(key, c);
    }
  }
  const rows = [...mergedRows.values()];

  // Basic2 union (OBP/OPS/SLG 등)
  const basic2Rows = basic2Htmls.flatMap((html) => parseTable(html));
  const runnerRows = parseTable(runnerHtml);

  // 규정타석 충족 선수 셋 — 비율스탯 리더보드(규정타석만 노출) union
  // (단일 HRA_RT는 타율 31위↓ 규정타석 선수를 놓쳐 OPS/OBP/SLG 랭킹 누락 유발)
  const qualifiedKeys = new Set<string>();
  for (const sort of rateSorts) {
    const idx = basic1Sorts.indexOf(sort);
    for (const c of parseTable(basic1Htmls[idx])) {
      qualifiedKeys.add(`${(c[1] || "").trim()}::${(c[2] || "").trim()}`);
    }
  }

  // Basic2 lookup: name+team → { bb, ibb, hbp, so, gdp, slg, obp, ops }
  const basic2Map = new Map<string, { bb: number; ibb: number; hbp: number; so: number; gdp: number; slg: string; obp: string; ops: string }>();
  for (const c of basic2Rows) {
    const key = `${(c[1] || "").trim()}::${(c[2] || "").trim()}`;
    basic2Map.set(key, {
      bb: parseInt(c[4]) || 0,
      ibb: parseInt(c[5]) || 0,
      hbp: parseInt(c[6]) || 0,
      so: parseInt(c[7]) || 0,
      gdp: parseInt(c[8]) || 0,
      slg: c[9] || ".000",
      obp: c[10] || ".000",
      ops: c[11] || ".000",
    });
  }

  // Runner lookup: name+team → { sb, cs }
  const runnerMap = new Map<string, { sb: number; cs: number }>();
  for (const c of runnerRows) {
    const key = `${(c[1] || "").trim()}::${(c[2] || "").trim()}`;
    runnerMap.set(key, {
      sb: parseInt(c[5]) || 0,
      cs: parseInt(c[6]) || 0,
    });
  }

  return rows.map((c, i) => {
    const name = (c[1] || "").trim();
    const team = (c[2] || "").trim();
    const lookupKey = `${name}::${team}`;
    const found = resolvePlayer({ name, team }, roster, { context: "api/stats:batter" });
    const b2 = basic2Map.get(lookupKey);
    const runner = runnerMap.get(lookupKey);
    return {
      rank: i + 1,
      name,
      team,
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
      // Basic2 stats
      bb: b2?.bb || 0,
      ibb: b2?.ibb || 0,
      hbp: b2?.hbp || 0,
      so: b2?.so || 0,
      gdp: b2?.gdp || 0,
      slg: b2?.slg || ".000",
      obp: b2?.obp || ".000",
      ops: b2?.ops || ".000",
      // Runner stats
      sb: runner?.sb || 0,
      cs: runner?.cs || 0,
      kboId: found?.kboId || "",
      playerId: found?.kboId || "",
      qualifiedRate: qualifiedKeys.has(`${name}::${team}`) ? 1 : 0,
    };
  });
}

function parsePitcherRow(c: string[], roster: RosterPlayer[]): PlayerStat {
  const name = c[1] || "";
  const team = c[2] || "";
  const found = resolvePlayer({ name, team }, roster, { context: "api/stats:pitcher" });
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
  const qualifiedKeys = new Set<string>(); // ERA_RT 페이지에 나오는 규정이닝 충족 선수

  const results = await Promise.all(
    sortKeys.map(async (sort) => {
      const url = `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=${sort}`;
      const html = await fetchHtml(url);
      return { sort, rows: parseTable(html) };
    })
  );

  for (const { sort, rows } of results) {
    for (const c of rows) {
      const name = c[1] || "";
      const team = c[2] || "";
      const key = `${name}::${team}`;
      if (sort === "ERA_RT") {
        qualifiedKeys.add(key);
      }
      if (!merged.has(key)) {
        merged.set(key, parsePitcherRow(c, roster));
      }
    }
  }

  // ERA 기준 정렬 후 순위 부여 + 규정이닝 플래그
  const stats = [...merged.values()]
    .sort((a, b) => Number(a.era || 99) - Number(b.era || 99));
  stats.forEach((p, i) => {
    p.rank = i + 1;
    p.qualifiedRate = qualifiedKeys.has(`${p.name}::${p.team}`) ? 1 : 0;
  });
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
