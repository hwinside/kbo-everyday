import { NextRequest, NextResponse } from "next/server";
import { fetchStandings, fetchGames } from "@/lib/crawler/kbo-api";
import { getMonthGames } from "@/lib/crawler/season-games-cache";
import { TEAMS } from "@/lib/constants/teams";

// GET /api/team-card?team=<slug>
// 홈 팀 카드용 데이터 조립: 순위/게임차 + 연승연패 + 최근 5경기 폼 + 다음 경기(예고선발).
// 기존 lib(fetchStandings/getMonthGames/fetchGames) 재사용. 신규 크롤 없음.

type FormResult = "W" | "L" | "D";

function kstDateStr(offsetDays: number): string {
  const base = new Date(Date.now() + 9 * 60 * 60 * 1000);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10).replace(/-/g, "");
}

// 이웃 팀과의 게임차 = KBO 공식 게임차(1위 대비)의 차이. 순위(승률 기준)와
// raw 승차가 어긋나는 엣지케이스에서도 KBO 표기와 일치하게 절대값으로.
function gapBetween(a: { gamesBehind: number }, b: { gamesBehind: number }): number {
  return Math.abs(a.gamesBehind - b.gamesBehind);
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("team");
  const team = TEAMS.find((t) => t.slug === slug);
  if (!team) {
    return NextResponse.json({ error: "Unknown team slug" }, { status: 400 });
  }

  try {
    // 1) 순위 + 게임차 + 연승연패
    const standings = await fetchStandings();
    const ranked = [...standings].sort((a, b) => b.winRate - a.winRate);
    const idx = ranked.findIndex((s) => s.teamId === team.id);
    const me = idx >= 0 ? ranked[idx] : null;

    const standing = me
      ? {
          rank: idx + 1,
          gamesBehind: me.gamesBehind, // 1위 대비
          streak: me.continuousGameResult ?? null,
          above:
            idx > 0
              ? { teamId: ranked[idx - 1].teamId, gap: gapBetween(ranked[idx - 1], me) }
              : null,
          below:
            idx < ranked.length - 1
              ? { teamId: ranked[idx + 1].teamId, gap: gapBetween(me, ranked[idx + 1]) }
              : null,
        }
      : null;

    // 2) 최근 5경기 폼 — 이번 달(부족하면 지난 달까지) 종료 경기에서 산출
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const thisMonth = now.toISOString().slice(0, 7);
    const prev = new Date(now);
    prev.setUTCMonth(prev.getUTCMonth() - 1);
    const prevMonth = prev.toISOString().slice(0, 7);

    let monthGames = await getMonthGames(thisMonth).catch(() => []);
    let teamFinals = monthGames.filter(
      (g) => (g.awayTeamId === team.id || g.homeTeamId === team.id) && g.status === "final",
    );
    if (teamFinals.length < 5) {
      const prevGames = await getMonthGames(prevMonth).catch(() => []);
      monthGames = [...prevGames, ...monthGames];
      teamFinals = monthGames.filter(
        (g) => (g.awayTeamId === team.id || g.homeTeamId === team.id) && g.status === "final",
      );
    }
    teamFinals.sort((a, b) => a.date.localeCompare(b.date));
    const recentForm: FormResult[] = teamFinals
      .slice(-5)
      .map((g) => {
        const isHome = g.homeTeamId === team.id;
        const my = isHome ? g.homeScore : g.awayScore;
        const opp = isHome ? g.awayScore : g.homeScore;
        if (my == null || opp == null) return null;
        return my > opp ? "W" : my < opp ? "L" : "D";
      })
      .filter((r): r is FormResult => r !== null);

    // 3) 다음 경기 + 예고선발 (라이브 fetchGames로 최신 예고선발 확보)
    let nextGame: {
      gameId: string;
      date: string;
      time: string;
      stadium: string;
      home: boolean;
      opponentId: number;
      myStarter: string | null;
      oppStarter: string | null;
    } | null = null;
    for (let i = 0; i < 10 && !nextGame; i++) {
      const date = kstDateStr(i);
      const games = await fetchGames(date).catch(() => []);
      const g = games.find(
        (x) =>
          (x.awayTeamId === team.id || x.homeTeamId === team.id) && x.status === "scheduled",
      );
      if (g) {
        const isHome = g.homeTeamId === team.id;
        nextGame = {
          gameId: g.gameId,
          date: g.date,
          time: g.time,
          stadium: g.stadium,
          home: isHome,
          opponentId: isHome ? g.awayTeamId : g.homeTeamId,
          myStarter: (isHome ? g.homeStarterName : g.awayStarterName) || null,
          oppStarter: (isHome ? g.awayStarterName : g.homeStarterName) || null,
        };
      }
    }

    return NextResponse.json(
      { team: team.slug, standing, recentForm, nextGame },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
