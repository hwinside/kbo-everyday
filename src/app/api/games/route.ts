import { NextRequest, NextResponse } from "next/server";
import { fetchGames, USER_FACING_GAMES_TIMEOUT_MS } from "@/lib/crawler/kbo-api";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!date || !/^\d{8}$/.test(date)) {
    return NextResponse.json({ error: "date param required (YYYYMMDD)" }, { status: 400 });
  }

  try {
    // user-facing 경로: KBO blackhole 에서 10s 정지 대신 공통 budget 안에 Naver 폴백로 수렴.
    const games = await fetchGames(date, undefined, { timeoutMs: USER_FACING_GAMES_TIMEOUT_MS });
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
