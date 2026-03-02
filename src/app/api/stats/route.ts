import { NextRequest, NextResponse } from "next/server";

const KBO_BASE = "https://www.koreabaseball.com";

const TEAM_CODE_MAP: Record<string, string> = {
  LG: "LG", 두산: "OB", KT: "KT", SSG: "SK", NC: "NC",
  KIA: "HT", 롯데: "LT", 삼성: "SS", 한화: "HH", 키움: "WO",
};

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
    next: { revalidate: 3600 }, // 1시간 캐시
  });
  return res.text();
}

function parseTable(html: string): string[][] {
  const rows: string[][] = [];
  // tbody 내의 tr 추출
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
        // HTML 태그 제거, 공백 정리
        const text = td.replace(/<[^>]+>/g, "").trim();
        cells.push(text);
      }
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

// 타자 기본 기록
async function fetchBatterStats(year: string = "2025"): Promise<PlayerStat[]> {
  const url = `${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=HRA_RT`;
  const html = await fetchHtml(url);
  const rows = parseTable(html);
  
  return rows.slice(0, 30).map((cols, i) => ({
    rank: i + 1,
    name: cols[1] || "",
    team: cols[2] || "",
    avg: cols[3] || ".000",
    games: parseInt(cols[4]) || 0,
    pa: parseInt(cols[5]) || 0,    // 타석
    ab: parseInt(cols[6]) || 0,    // 타수
    runs: parseInt(cols[7]) || 0,  // 득점
    hits: parseInt(cols[8]) || 0,  // 안타
    doubles: parseInt(cols[9]) || 0,
    triples: parseInt(cols[10]) || 0,
    hr: parseInt(cols[11]) || 0,
    rbi: parseInt(cols[12]) || 0,  // 타점
    sb: parseInt(cols[13]) || 0,   // 도루
    bb: parseInt(cols[14]) || 0,   // 볼넷
    so: parseInt(cols[15]) || 0,   // 삼진
    obp: cols[16] || ".000",       // 출루율
    slg: cols[17] || ".000",       // 장타율
    ops: cols[18] || ".000",       // OPS
  }));
}

// 투수 기본 기록
async function fetchPitcherStats(year: string = "2025"): Promise<PlayerStat[]> {
  const url = `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=ERA_RT`;
  const html = await fetchHtml(url);
  const rows = parseTable(html);
  
  return rows.slice(0, 30).map((cols, i) => ({
    rank: i + 1,
    name: cols[1] || "",
    team: cols[2] || "",
    era: cols[3] || "0.00",
    games: parseInt(cols[4]) || 0,
    wins: parseInt(cols[5]) || 0,
    losses: parseInt(cols[6]) || 0,
    saves: parseInt(cols[7]) || 0,
    holds: parseInt(cols[8]) || 0,
    ip: cols[9] || "0.0",          // 이닝
    hits: parseInt(cols[10]) || 0,
    hr: parseInt(cols[11]) || 0,
    bb: parseInt(cols[12]) || 0,    // 볼넷
    hbp: parseInt(cols[13]) || 0,   // 사구
    so: parseInt(cols[14]) || 0,    // 삼진
    runs: parseInt(cols[15]) || 0,  // 실점
    er: parseInt(cols[16]) || 0,    // 자책
    whip: cols[17] || "0.00",
  }));
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") || "batter";
  
  try {
    const stats = type === "pitcher" 
      ? await fetchPitcherStats()
      : await fetchBatterStats();
    
    return NextResponse.json({ stats, type, count: stats.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, stats: [] }, { status: 500 });
  }
}
