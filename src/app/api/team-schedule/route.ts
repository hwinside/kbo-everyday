import { summarizeRegularSeasonResults } from "@/lib/crawler/game-series";
import { NextRequest, NextResponse } from "next/server";
import { getMonthGames } from "@/lib/crawler/season-games-cache";
import { TEAMS } from "@/lib/constants/teams";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const teamSlug = searchParams.get("team");
  const month = searchParams.get("month"); // YYYY-MM

  if (!teamSlug || !month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json(
      { error: "team (slug) and month (YYYY-MM) are required" },
      { status: 400 }
    );
  }

  const team = TEAMS.find((t) => t.slug === teamSlug);
  if (!team) {
    return NextResponse.json({ error: "Unknown team slug" }, { status: 404 });
  }

  try {
    const { refreshPostseasonSchedule } = await import("@/lib/postseason/schedule");
    const allGames = await refreshPostseasonSchedule(await getMonthGames(month), month.replace("-", "") + "01", month.replace("-", "") + "31");

    // Filter games involving this team
    const teamGames = allGames.filter(
      (g) => g.awayTeamId === team.id || g.homeTeamId === team.id
    );

    const days = teamGames.map((g) => {
      const isHome = g.homeTeamId === team.id;
      const oppId = isHome ? g.awayTeamId : g.homeTeamId;
      const oppTeam = TEAMS.find((t) => t.id === oppId);

      let result: "W" | "L" | "D" | null = null;
      if (g.status === "final") {
        const myScore = isHome ? g.homeScore : g.awayScore;
        const oppScore = isHome ? g.awayScore : g.homeScore;
        if (myScore !== null && oppScore !== null) {
          if (myScore > oppScore) { result = "W"; }
          else if (myScore < oppScore) { result = "L"; }
          else { result = "D"; }
        }
      }

      // Parse YYYYMMDD into day number
      const day = parseInt(g.date.slice(6, 8), 10);

      return {
        day,
        date: g.date,
        gameId: g.gameId,
        srId: g.srId,
        gameLabel: g.gameLabel,
        opponent: oppTeam
          ? { id: oppTeam.id, slug: oppTeam.slug, shortName: oppTeam.shortName, name: oppTeam.name }
          : { id: oppId, slug: "", shortName: "", name: "" },
        home: isHome,
        status: g.status,
        // 취소 사유는 취소 상태일 때만 실는다(값-플래그 결속). Naver 폴백 경로는 null.
        cancelReason: g.status === "cancelled" ? (g.cancelReason ?? null) : null,
        result,
        score: {
          for: isHome ? g.homeScore : g.awayScore,
          against: isHome ? g.awayScore : g.homeScore,
        },
        stadium: g.stadium,
        time: g.time,
        starterName: isHome ? g.homeStarterName : g.awayStarterName,
      };
    });

    const summary = summarizeRegularSeasonResults(days);

    return NextResponse.json(
      { team: teamSlug, month, summary, days },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30" } }
    );
  } catch (e: unknown) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
