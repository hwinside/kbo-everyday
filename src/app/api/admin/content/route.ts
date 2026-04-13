import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminRequest } from "@/lib/admin/pin";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function verifyPin(req: NextRequest): boolean {
  return isAdminRequest(req);
}

export async function GET(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const days = Number(req.nextUrl.searchParams.get("days") ?? "30");
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  // Posts
  const { data: posts, error: postsError } = await supabase
    .from("posts")
    .select("created_at, content_type, board_id")
    .gte("created_at", since);

  if (postsError) return supabaseErrorResponse(postsError);

  // Comments
  const { data: comments, error: commentsError } = await supabase
    .from("comments")
    .select("created_at")
    .gte("created_at", since);

  if (commentsError) return supabaseErrorResponse(commentsError);

  // Daily aggregation
  const dailyMap = new Map<string, { posts: number; comments: number; photos: number }>();

  for (const post of posts ?? []) {
    const date = post.created_at.slice(0, 10);
    const entry = dailyMap.get(date) ?? { posts: 0, comments: 0, photos: 0 };
    entry.posts += 1;
    if (post.content_type === "photo") entry.photos += 1;
    dailyMap.set(date, entry);
  }

  for (const comment of comments ?? []) {
    const date = comment.created_at.slice(0, 10);
    const entry = dailyMap.get(date) ?? { posts: 0, comments: 0, photos: 0 };
    entry.comments += 1;
    dailyMap.set(date, entry);
  }

  const dailyPosts = Array.from(dailyMap.entries())
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Popular posts top 10
  const { data: popularPosts, error: popularError } = await supabase
    .from("posts")
    .select("id, title, board_id, board_type, like_count, comment_count, created_at, image_urls")
    .order("like_count", { ascending: false })
    .limit(10);

  if (popularError) return supabaseErrorResponse(popularError);

  // Team activity: count posts grouped by board_id
  const boardMap = new Map<string, number>();
  for (const post of posts ?? []) {
    const key = post.board_id;
    boardMap.set(key, (boardMap.get(key) ?? 0) + 1);
  }
  const teamActivity = Array.from(boardMap.entries()).map(
    ([board_id, count]) => ({ board_id, count }),
  );

  return NextResponse.json({
    dailyPosts,
    popularPosts,
    teamActivity,
  });
}
