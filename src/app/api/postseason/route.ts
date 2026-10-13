import { NextResponse } from "next/server";
import { REGULAR_SEASON_WINDOWS } from "@/lib/constants/season";
import { fetchNaverGames } from "@/lib/crawler/naver-games";
import { fetchKboGamesOnly, resolveTeamId } from "@/lib/crawler/kbo-api";
import { getTeamById } from "@/lib/constants/teams";
import { buildPostseasonLadder, type Seed, type LadderSnapshot } from "@/lib/postseason/ladder";

export const maxDuration = 15;
let cached: LadderSnapshot | null = null;
async function loadSeeds(season: number): Promise<Seed[]> {
  try {
    const response = await fetch(`https://api-gw.sports.naver.com/statistics/categories/kbo/seasons/${season}/teams?gameType=REGULAR_SEASON`, {
      headers: { Referer: "https://sports.news.naver.com/" }, signal: AbortSignal.timeout(2500), cache: "no-store",
    });
    if (!response.ok) return [];
    const body = await response.json();
    const rows = body?.success === true ? body.result?.seasonTeamStats : null;
    if (!Array.isArray(rows) || rows.length !== 10) return [];
    const seeds: Seed[] = rows.map((r: { ranking: number; teamId: string; gameCount: number }) => {
      if (r.gameCount !== 144) throw new Error("Regular standings not final");
      const teamId = resolveTeamId(r.teamId, "");
      const name = getTeamById(teamId)?.shortName;
      if (!name || !Number.isInteger(r.ranking) || r.ranking < 1 || r.ranking > 10) throw new Error("Invalid final standings");
      return { rank: r.ranking, teamId, name };
    });
    if (new Set(seeds.map(s=>s.rank)).size !== 10 || new Set(seeds.map(s=>s.teamId)).size !== 10) return [];
    return seeds.filter(s=>s.rank <= 5);
  } catch { return []; }
}
export async function GET() {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replaceAll("-", "");
  const season = Number(today.slice(0,4));
  const window = REGULAR_SEASON_WINDOWS[String(season)];
  if (!window?.finalized || today <= window.end) return NextResponse.json({ active: false }, { headers: { "Cache-Control": "no-store" } });
  try {
    if (cached?.season === season && Date.now()-cached.fetchedAt < 30_000) return NextResponse.json({ active: true, ...cached }, { headers: { "Cache-Control": "no-store" } });
    const [games, seeds] = await Promise.all([
      fetchNaverGames(window.end, undefined, { toDate: `${season}1130`, signal: AbortSignal.timeout(3000) }), loadSeeds(season),
    ]);
    // Naver's schedule omits game number. Enrich only from KBO labels; never
    // fabricate a number from date order (ties/postponements can change it).
    const dates = [...new Set(games.filter(g=>["3","4","5","7"].includes(g.srId ?? "")).map(g=>g.date))];
    const labels = new Map<string,string>();
    const labelSignal = AbortSignal.timeout(2500);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, dates.length) }, async () => {
      while (cursor < dates.length && !labelSignal.aborted) {
        const date = dates[cursor++];
        try {
          const rows = await fetchKboGamesOnly(date, "3,4,5,7", { signal: labelSignal });
          for (const g of rows) if (g.gameLabel) labels.set(g.gameId,g.gameLabel);
        } catch { /* Missing labels never justify guessing a game number. */ }
      }
    }));
    cached = buildPostseasonLadder(season, games.map(g=>({...g, gameLabel: labels.get(g.gameId) ?? g.gameLabel})), seeds, Date.now());
    return NextResponse.json({ active: true, ...cached }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ active: true, error: "Postseason schedule unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
