import { NextResponse } from "next/server";
import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";

const KBO_SEARCH = "https://www.koreabaseball.com/ws/Controls.asmx/GetSearchPlayer";

const TEAM_SHORT_MAP: Record<string, number> = {
  LG: 1, OB: 2, KT: 3, SK: 4, NC: 5, HT: 6, LT: 7, SS: 8, HH: 9, WO: 10,
  "두산": 2, SSG: 4, KIA: 6, "롯데": 7, "삼성": 8, "한화": 9, "키움": 10,
};

interface PlayerTeamInfo {
  name: string;
  kboId: string;
  team: string;
  teamId: number;
  position: string;
  backNo: string;
}

// 인메모리 캐시 (1시간)
let cache: { data: PlayerTeamInfo[]; ts: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000;

async function searchPlayer(name: string): Promise<PlayerTeamInfo | null> {
  try {
    const res = await fetch(KBO_SEARCH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0" },
      body: `name=${encodeURIComponent(name)}`,
    });
    const data = await res.json();
    const now = data.now || [];
    if (now.length > 0) {
      const p = now[0];
      return {
        name: p.P_NM,
        kboId: String(p.P_ID),
        team: p.T_ID || p.T_NM || "",
        teamId: TEAM_SHORT_MAP[p.T_ID] || TEAM_SHORT_MAP[p.T_NM] || 0,
        position: p.POS_NO || "",
        backNo: p.BACK_NO || "",
      };
    }
  } catch {}
  return null;
}

async function fetchAllPlayerTeams(): Promise<PlayerTeamInfo[]> {
  const names = Object.keys(PLAYER_PHOTO_MAP);
  const results: PlayerTeamInfo[] = [];
  
  // 5개씩 병렬 (rate limit 방지)
  for (let i = 0; i < names.length; i += 5) {
    const batch = names.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(n => searchPlayer(n)));
    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }
  
  return results;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const nameQuery = searchParams.get("name");

  // 단건 조회 (이름 지정 시) — 빠름
  if (nameQuery) {
    const result = await searchPlayer(nameQuery);
    return NextResponse.json({ players: result ? [result] : [], count: result ? 1 : 0, cached: false });
  }

  // 전체 조회 (캐시)
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json({ players: cache.data, count: cache.data.length, cached: true });
  }

  try {
    const players = await fetchAllPlayerTeams();
    cache = { data: players, ts: Date.now() };
    return NextResponse.json({ players, count: players.length, cached: false });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, players: [] }, { status: 500 });
  }
}
