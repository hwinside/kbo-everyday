import { NextRequest, NextResponse } from "next/server";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { STADIUMS } from "@/lib/constants/stadiums";

/**
 * GET /api/stadiums/[stadiumId]/games?month=202604
 * 구장별 월 단위 홈경기 목록 반환
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ stadiumId: string }> }
) {
  const { stadiumId } = await params;
  const month = request.nextUrl.searchParams.get("month");

  if (!month || !/^\d{6}$/.test(month)) {
    return NextResponse.json({ error: "month param required (YYYYMM)" }, { status: 400 });
  }

  const stadium = STADIUMS.find((s) => s.id === stadiumId);
  if (!stadium) {
    return NextResponse.json({ error: "stadium not found" }, { status: 404 });
  }

  const homeTeamIds = new Set(stadium.teamIds);

  // 월의 날짜 범위 계산
  const year = parseInt(month.slice(0, 4));
  const mon = parseInt(month.slice(4, 6));
  const daysInMonth = new Date(year, mon, 0).getDate();

  try {
    // 모든 날짜를 병렬로 조회
    const datePromises = Array.from({ length: daysInMonth }, (_, i) => {
      const day = String(i + 1).padStart(2, "0");
      return fetchGames(`${month}${day}`).catch(() => []);
    });

    const allDays = await Promise.all(datePromises);

    // 홈경기만 필터
    const homeGames = allDays
      .flat()
      .filter((game) => homeTeamIds.has(game.homeTeamId));

    return NextResponse.json({
      stadiumId,
      month,
      count: homeGames.length,
      games: homeGames.map((g) => ({
        gameId: g.gameId,
        date: g.date,
        time: g.time,
        homeTeamId: g.homeTeamId,
        awayTeamId: g.awayTeamId,
        homeName: g.homeName,
        awayName: g.awayName,
        status: g.status,
      })),
    }, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" },
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
