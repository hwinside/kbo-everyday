import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  NewsDiscussionInputError,
  parseNewsDiscussionInput,
  type ParsedNewsDiscussionInput,
} from "@/lib/news/discussion";
import { allowNewsDiscussionRequest } from "@/lib/news/discussion-rate-limit";

function requesterKey(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

async function existingDiscussion(input: ParsedNewsDiscussionInput) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("news_discussions")
    .select("post_id, posts!inner(comment_count)")
    .eq("article_key", input.articleKey)
    .maybeSingle();
  return data as { post_id: number; posts: { comment_count?: number | null } | Array<{ comment_count?: number | null }> } | null;
}

function commentCount(row: { posts: { comment_count?: number | null } | Array<{ comment_count?: number | null }> }): number {
  const post = Array.isArray(row.posts) ? row.posts[0] : row.posts;
  return Math.max(0, Number(post?.comment_count ?? 0));
}

export async function POST(req: NextRequest) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SYSTEM_USER_ID) {
    return NextResponse.json({ error: "discussion service unavailable" }, { status: 503 });
  }
  if (!allowNewsDiscussionRequest(`ensure:${requesterKey(req)}`)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429 });
  }

  let input: ParsedNewsDiscussionInput;
  try {
    input = parseNewsDiscussionInput(await req.json());
  } catch (error) {
    const message = error instanceof NewsDiscussionInputError ? error.message : "invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const existing = await existingDiscussion(input);
  if (existing) {
    await supabase
      .from("news_discussions")
      .update({
        source_url: input.sourceUrl,
        title: input.title,
        source: input.source,
        thumbnail_url: input.thumbnailUrl,
        team_id: input.teamId,
        updated_at: new Date().toISOString(),
      })
      .eq("article_key", input.articleKey);
    return NextResponse.json({ postId: existing.post_id, commentCount: commentCount(existing) });
  }

  const { data: bridge, error: bridgeError } = await supabase
    .from("posts")
    .insert({
      author_id: process.env.SYSTEM_USER_ID,
      board_type: "news",
      board_id: input.articleKey,
      content_type: "general",
      title: input.title,
      content: input.canonicalUrl,
      is_hidden: true,
    })
    .select("id")
    .single();

  if (bridgeError || !bridge) {
    return NextResponse.json({ error: "failed to create discussion" }, { status: 500 });
  }

  const { error: linkError } = await supabase.from("news_discussions").insert({
    article_key: input.articleKey,
    post_id: bridge.id,
    canonical_url: input.canonicalUrl,
    source_url: input.sourceUrl,
    title: input.title,
    source: input.source,
    thumbnail_url: input.thumbnailUrl,
    team_id: input.teamId,
  });

  if (!linkError) return NextResponse.json({ postId: bridge.id, commentCount: 0 }, { status: 201 });

  // 동시 최초 생성에서 unique winner가 있으면 패배한 임시 post를 즉시 정리하고 winner를 반환한다.
  await supabase.from("posts").delete().eq("id", bridge.id);
  if (linkError.code === "23505") {
    const winner = await existingDiscussion(input);
    if (winner) return NextResponse.json({ postId: winner.post_id, commentCount: commentCount(winner) });
  }
  return NextResponse.json({ error: "failed to link discussion" }, { status: 500 });
}
