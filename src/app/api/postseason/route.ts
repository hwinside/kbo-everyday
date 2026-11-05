import { NextResponse } from "next/server";
import { loadPostseasonSchedule } from "@/lib/postseason/schedule";

export const maxDuration = 15;
export async function GET() {
  try {
    const snapshot = await loadPostseasonSchedule();
    return NextResponse.json(snapshot ? { active: true, ...snapshot } : { active: false }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ active: true, error: "Postseason schedule unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
