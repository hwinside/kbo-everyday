import { NextRequest, NextResponse } from "next/server";
import { fetchGames } from "@/lib/crawler/kbo-api";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!date || !/^\d{8}$/.test(date)) {
    return NextResponse.json({ error: "date param required (YYYYMMDD)" }, { status: 400 });
  }

  try {
    const games = await fetchGames(date);
    return NextResponse.json({
      date,
      count: games.length,
      games,
    }, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
