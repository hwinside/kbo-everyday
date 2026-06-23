import { NextRequest, NextResponse } from "next/server";
import { checkObjectionableContent } from "@/lib/moderation/content-filter";

// 모더레이션 필터는 src/lib/moderation/content-filter 로 공용화(서버/클라 동일 로직).
export async function POST(req: NextRequest) {
  const { title, content } = await req.json();
  const { allowed, issues } = checkObjectionableContent({ title, content });
  return NextResponse.json({ allowed, issues });
}
