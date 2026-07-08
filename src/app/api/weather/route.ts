import { NextRequest, NextResponse } from "next/server";
import { fetchStadiumWeather } from "@/lib/weather/stadium-weather";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  const stadiumsParam = request.nextUrl.searchParams.get("stadiums");
  if (!date || !/^\d{8}$/.test(date)) {
    return NextResponse.json({ error: "date param required (YYYYMMDD)" }, { status: 400 });
  }
  const stadiums = (stadiumsParam ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 16);
  if (stadiums.length === 0) {
    return NextResponse.json({ date, stadiums: {} });
  }

  try {
    const map = await fetchStadiumWeather(date, stadiums);
    return NextResponse.json(
      { date, stadiums: map },
      { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1800" } },
    );
  } catch (e: unknown) {
    // 날씨는 부가 정보 — 실패해도 경기 목록을 막지 않도록 빈 결과로 응답
    console.warn("[weather] fetch failed:", (e as Error).message);
    return NextResponse.json({ date, stadiums: {} });
  }
}
