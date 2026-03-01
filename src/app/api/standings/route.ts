import { NextResponse } from "next/server";
import { fetchStandings } from "@/lib/crawler/kbo-api";

export async function GET() {
  try {
    const standings = await fetchStandings();
    return NextResponse.json({
      count: standings.length,
      standings,
    }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
