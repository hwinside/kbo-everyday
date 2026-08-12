import { NextRequest, NextResponse } from "next/server";
import { resolvePlayer } from "@/lib/utils/resolve-player";

const KBO_BASE = "https://www.koreabaseball.com";

function parseTables(html: string): string[][][] {
  const result: string[][][] = [];
  const tbodies = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/gi) || [];
  for (const tb of tbodies) {
    const rows: string[][] = [];
    const trs = tb.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (const tr of trs) {
      const cells = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
        .map(td => td.replace(/<[^>]+>/g, "").trim());
      if (cells.length > 0) rows.push(cells);
    }
    result.push(rows);
  }
  return result;
}

async function fetchPlayerStats(playerId: string, position: string) {
  const isPitcher = position === "투수";
  const url = isPitcher
    ? `${KBO_BASE}/Record/Player/PitcherDetail/Basic.aspx?playerId=${playerId}`
    : `${KBO_BASE}/Record/Player/HitterDetail/Basic.aspx?playerId=${playerId}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: KBO_BASE },
    next: { revalidate: 3600 },
  });
  // 업스트림 장애(403/5xx)는 throw → 500 no-store. '기록 없음'과 구분(삼순 NO-GO #3).
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const html = await res.text();
  const tables = parseTables(html);

  if (isPitcher) {
    // Table 0: 팀, ERA, G, CG, SHO, W, L, SV, HLD, WPCT, TBF, NP, IP, H, 2B, 3B, HR
    // Table 1: SAC, SF, BB, IBB, SO, WP, BK, R, ER, BSV, WHIP, AVG, QS
    const t0 = tables[0]?.[0];
    const t1 = tables[1]?.[0];
    // 테이블 자체가 없는 비정상 HTML은 장애로 취급(throw → no-store) — 명시적 '기록 없음'만 null.
    if (!t0) throw new Error("upstream parse anomaly: pitcher tables missing");
    if (t0[0] === "기록이 없습니다.") return null;
    return {
      team: t0[0], era: t0[1], games: parseInt(t0[2]) || 0,
      cg: parseInt(t0[3]) || 0, sho: parseInt(t0[4]) || 0,
      wins: parseInt(t0[5]) || 0, losses: parseInt(t0[6]) || 0,
      saves: parseInt(t0[7]) || 0, holds: parseInt(t0[8]) || 0,
      wpct: t0[9], ip: t0[12], hits: parseInt(t0[13]) || 0, hr: parseInt(t0[16]) || 0,
      bb: parseInt(t1?.[2]) || 0, so: parseInt(t1?.[4]) || 0,
      er: parseInt(t1?.[8]) || 0, whip: t1?.[10] || "0.00",
    };
  } else {
    // Table 0: 팀, AVG, G, PA, AB, R, H, 2B, 3B, HR, TB, RBI, SB, CS, SAC, SF
    // Table 1: BB, IBB, HBP, SO, GDP, SLG, OBP, E, SB%, MH, OPS, RISP, PH-BA
    const t0 = tables[0]?.[0];
    const t1 = tables[1]?.[0];
    if (!t0) throw new Error("upstream parse anomaly: hitter tables missing");
    if (t0[0] === "기록이 없습니다.") return null;
    return {
      team: t0[0], avg: t0[1], games: parseInt(t0[2]) || 0,
      pa: parseInt(t0[3]) || 0, ab: parseInt(t0[4]) || 0,
      runs: parseInt(t0[5]) || 0, hits: parseInt(t0[6]) || 0,
      doubles: parseInt(t0[7]) || 0, triples: parseInt(t0[8]) || 0,
      hr: parseInt(t0[9]) || 0, tb: parseInt(t0[10]) || 0,
      rbi: parseInt(t0[11]) || 0, sb: parseInt(t0[12]) || 0,
      cs: parseInt(t0[13]) || 0, sac: parseInt(t0[14]) || 0, sf: parseInt(t0[15]) || 0,
      bb: parseInt(t1?.[0]) || 0, hbp: parseInt(t1?.[2]) || 0,
      so: parseInt(t1?.[3]) || 0,
      slg: t1?.[5] || ".000", obp: t1?.[6] || ".000", ops: t1?.[10] || ".000",
    };
  }
}

interface PitcherDetailStats {
  team: string; era: string; games: number;
  cg: number; sho: number; wins: number; losses: number;
  saves: number; holds: number; wpct: string | undefined;
  ip: string; hits: number; hr: number;
  bb: number; so: number; er: number; whip: string;
}

interface BatterDetailStats {
  team: string; avg: string; games: number;
  pa: number; ab: number; runs: number; hits: number;
  doubles: number; triples: number; hr: number; tb: number;
  rbi: number; sb: number; cs: number; sac: number; sf: number; bb: number; hbp: number;
  so: number; slg: string; obp: string; ops: string;
}

type PlayerDetailStats = PitcherDetailStats | BatterDetailStats;

const cache: Record<string, { data: PlayerDetailStats; ts: number }> = {};

export async function GET(req: NextRequest) {
  const rawId = req.nextUrl.searchParams.get("id");
  const pos = req.nextUrl.searchParams.get("pos") || "타자";
  if (!rawId) return NextResponse.json({ error: "id required" }, { status: 400 });

  // KBO 공식 사이트는 숫자 ID만 인식 → resolvePlayer가 외국인 alpha→numeric 변환 처리
  const id = resolvePlayer(rawId)?.numericId || rawId;

  const cacheKey = `player-${id}-${pos}`;
  // 엣지 s-maxage=60 상한 — upstream revalidate(1h)+인메모리(1h)+엣지 누적을 막는다(삼순 NO-GO #2, 30~60s 상한안).
  // SWR 미사용, 장애 응답 캐시 금지.
  const OK_HEADERS = { "Cache-Control": "public, s-maxage=60" } as const;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.ts < 3600000) {
    return NextResponse.json({ stats: cached.data, cached: true }, { headers: OK_HEADERS });
  }

  try {
    const stats = await fetchPlayerStats(id, pos);
    if (stats) cache[cacheKey] = { data: stats, ts: Date.now() };
    // stats null = 명시적 '기록이 없습니다.'만 도달(장애는 throw) — 동일 60초 캐시.
    return NextResponse.json({ stats, cached: false }, { headers: OK_HEADERS });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message, stats: null }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
