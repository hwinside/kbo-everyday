/**
 * 선수 주 포지션 맵 생성 (네이버 선수 상세 → kboId:position). 맥미니 0 (순수 fetch).
 * 예상 WAR 포지션 보정용. 포지션은 시즌 중 거의 불변이라 주기적(수동/CI) 재생성.
 * 실행: npx tsx scripts/gen-player-positions.ts [season]
 * 출력: src/lib/constants/player-positions.json  { [kboId]: "SHORTSTOP" ... }
 */
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const SEASON = process.argv[2] || "2026";
const BASE = "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons";
const H = { "User-Agent": "Mozilla/5.0", Referer: "https://m.sports.naver.com/" };

async function listHitterIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${BASE}/${SEASON}/players?playerType=HITTER&gameType=REGULAR_SEASON&page=${page}&pageSize=100`, { headers: H });
    if (!r.ok) break;
    const j = await r.json();
    const rows = j?.result?.seasonPlayerStats ?? [];
    if (!rows.length) break;
    const before = ids.size;
    for (const x of rows) if (x.playerId) ids.add(String(x.playerId));
    if (ids.size === before) break;
  }
  return [...ids];
}

async function position(id: string): Promise<string | null> {
  const r = await fetch(`${BASE}/${SEASON}/players/${id}?gameType=REGULAR_SEASON`, { headers: H });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result?.player?.position ?? null;
}

async function main() {
  const ids = await listHitterIds();
  const map: Record<string, string> = {};
  for (const id of ids) {
    const pos = await position(id);
    if (pos) map[id] = pos;
  }
  const out = join(dirname(fileURLToPath(import.meta.url)), "../src/lib/constants/player-positions.json");
  writeFileSync(out, JSON.stringify(map, null, 0) + "\n");
  console.log(`[gen-player-positions] ${Object.keys(map).length}명 포지션 → ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
