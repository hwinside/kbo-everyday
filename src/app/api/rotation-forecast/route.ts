import { NextRequest, NextResponse } from "next/server";
import { getMonthGames } from "@/lib/crawler/season-games-cache";
import { forecastAll } from "@/lib/rotation/forecast";

/**
 * 미공시 예정 경기의 팀별 예측 선발투수.
 * GET /api/rotation-forecast?date=YYYYMMDD
 * 응답: { date, predictions: { [gameId]: { awayStarter?, homeStarter? } } }
 */
export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!date || !/^\d{8}$/.test(date)) {
    return NextResponse.json({ error: "date param required (YYYYMMDD)" }, { status: 400 });
  }

  try {
    const y = parseInt(date.slice(0, 4));
    const m = parseInt(date.slice(4, 6));
    const month = `${y}-${String(m).padStart(2, "0")}`;
    const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;

    // 직전 달까지 합쳐 로테이션 history 확보(시즌 초·월초 대비). 월별 캐시라 비용 작음.
    const [prev, cur] = await Promise.all([getMonthGames(prevMonth), getMonthGames(month)]);
    const games = [...prev, ...cur];

    const all = forecastAll(games);
    const predictions: Record<string, { awayStarter?: string; homeStarter?: string }> = {};
    for (const g of games) {
      if (g.date !== date) continue;
      const p = all.get(g.gameId);
      if (p && (p.awayStarter || p.homeStarter)) predictions[g.gameId] = p;
    }

    return NextResponse.json(
      { date, predictions },
      { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1800" } },
    );
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
