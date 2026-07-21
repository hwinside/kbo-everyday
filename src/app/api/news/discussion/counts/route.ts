import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  mapDiscussionCounts,
  NewsDiscussionInputError,
  parseCountLookups,
} from "@/lib/news/discussion";
import { allowNewsDiscussionRequest } from "@/lib/news/discussion-rate-limit";

export async function POST(req: NextRequest) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "discussion service unavailable" }, { status: 503 });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!allowNewsDiscussionRequest(`counts:${ip}`)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429 });
  }

  let lookups: ReturnType<typeof parseCountLookups>;
  try {
    lookups = parseCountLookups(await req.json());
  } catch (error) {
    const message = error instanceof NewsDiscussionInputError ? error.message : "invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (lookups.length === 0) return NextResponse.json({ counts: {} });

  const { data, error } = await getSupabaseAdmin()
    .from("news_discussions")
    .select("article_key, posts!inner(comment_count)")
    .in("article_key", [...new Set(lookups.map((item) => item.articleKey))]);
  if (error) return NextResponse.json({ error: "failed to load counts" }, { status: 500 });

  return NextResponse.json({ counts: mapDiscussionCounts(lookups, data ?? []) });
}
