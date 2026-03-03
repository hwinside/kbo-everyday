import { NextRequest, NextResponse } from "next/server";

const KBO_BASE = "https://www.koreabaseball.com";

async function fetchPlayerStats(playerId: string, position: string) {
  const isPitcher = position === "투수";
  const url = isPitcher
    ? `${KBO_BASE}/Record/Player/PitcherDetail/Basic.aspx?playerId=${playerId}`
    : `${KBO_BASE}/Record/Player/HitterDetail/Basic.aspx?playerId=${playerId}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: KBO_BASE },
    next: { revalidate: 3600 },
  });
  const html = await res.text();

  const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbody) return null;

  const rows = (tbody[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || []);
  if (rows.length === 0) return null;

  // 마지막 행이 가장 최신 시즌 (또는 '통산')
  // 2025 시즌 행 찾기
  for (const tr of rows) {
    const cells = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(td => td.replace(/<[^>]+>/g, "").trim());

    if (cells.length < 5) continue;

    // 첫 셀이 팀명 (시즌별) 또는 연도
    if (isPitcher) {
      // 투수: 팀, ERA, 경기, 완투, 완봉, 승, 패, 세, 홀, 승률, 이닝, 피안, 피홈, 볼넷, 사구, 삼진, 실점, 자책, WHIP
      return {
        team: cells[0],
        era: cells[1] || "0.00",
        games: parseInt(cells[2]) || 0,
        wins: parseInt(cells[5]) || 0,
        losses: parseInt(cells[6]) || 0,
        saves: parseInt(cells[7]) || 0,
        holds: parseInt(cells[8]) || 0,
        ip: cells[10] || "0",
        hits: parseInt(cells[11]) || 0,
        hr: parseInt(cells[12]) || 0,
        bb: parseInt(cells[13]) || 0,
        so: parseInt(cells[15]) || 0,
        er: parseInt(cells[17]) || 0,
        whip: cells[18] || "0.00",
      };
    } else {
      // 타자: 팀, 타율, 경기, 타석, 타수, 득점, 안타, 2루타, 3루타, 홈런, 타점, 도루, ...
      return {
        team: cells[0],
        avg: cells[1] || ".000",
        games: parseInt(cells[2]) || 0,
        pa: parseInt(cells[3]) || 0,
        ab: parseInt(cells[4]) || 0,
        runs: parseInt(cells[5]) || 0,
        hits: parseInt(cells[6]) || 0,
        doubles: parseInt(cells[7]) || 0,
        triples: parseInt(cells[8]) || 0,
        hr: parseInt(cells[9]) || 0,
        rbi: parseInt(cells[10]) || 0,
        sb: parseInt(cells[11]) || 0,
      };
    }
  }
  return null;
}

// 캐시 (1시간)
const cache: Record<string, { data: any; ts: number }> = {};

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const pos = req.nextUrl.searchParams.get("pos") || "타자";

  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const cacheKey = `player-${id}-${pos}`;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.ts < 3600000) {
    return NextResponse.json({ stats: cached.data, cached: true });
  }

  try {
    const stats = await fetchPlayerStats(id, pos);
    if (stats) cache[cacheKey] = { data: stats, ts: Date.now() };
    return NextResponse.json({ stats, cached: false });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, stats: null }, { status: 500 });
  }
}
