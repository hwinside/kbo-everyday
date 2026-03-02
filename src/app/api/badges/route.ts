import { NextRequest, NextResponse } from "next/server";
import { checkAndAwardBadges } from "@/lib/supabase/badge-engine";

export async function POST(req: NextRequest) {
  const { userId } = await req.json();
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const newBadges = await checkAndAwardBadges(userId);

  return NextResponse.json({ newBadges, count: newBadges.length });
}
