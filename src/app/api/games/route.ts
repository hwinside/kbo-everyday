import { NextRequest, NextResponse } from "next/server";
import { fetchGamesUserFacing } from "@/lib/crawler/games-user-facing";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!date || !/^\d{8}$/.test(date)) {
    return NextResponse.json({ error: "date param required (YYYYMMDD)" }, { status: 400 });
  }

  try {
    // user-facing 하이브리드: Naver primary(스코어/이닝/상태) + KBO enrich(BSO/주자/투타) 병렬 병합.
    const games = await fetchGamesUserFacing(date);
    return NextResponse.json({
      date,
      count: games.length,
      games,
    }, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
