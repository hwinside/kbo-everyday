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
    .select("post_id")
    .eq("article_key", input.articleKey)
    .maybeSingle();
  return data as { post_id: number } | null;
}

async function visibleCommentCount(articleKey: string): Promise<number> {
  const { data, error } = await getSupabaseAdmin().rpc("news_discussion_visible_counts", {
    p_article_keys: [articleKey],
  });
  if (error) throw error;
  const row = (data as Array<{ visible_comment_count?: number | string | null }> | null)?.[0];
  return Math.max(0, Number(row?.visible_comment_count ?? 0));
}

export async function POST(req: NextRequest) {
  // 기사 댓글 브릿지 ensure 는 공개다(비로그인 포함) — 커뮤니티 댓글과 동일 계약:
  // 조회/브릿지 생성은 열되, 실제 댓글 작성은 CommentSheet(user 필수→LoginSheet)가 막는다.
  // 남용 방지는 rate-limit + 입력검증 + author=SYSTEM_USER_ID + 최초 metadata immutable 로 한다.
  // (게이트를 로그인 전용으로 두면 비로그인 CTA 탭이 401→generic 실패로 끝나 LoginSheet 에
  //  도달하지 못하는 blocker 가 생긴다 — 삼순 리뷰.)
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
    // 공개 ensure 요청은 최초 저장된 메타데이터를 절대 갱신하지 않는다.
    // canonical URL을 아는 제3자가 운영자 링크/제목을 오염시키는 것을 막는다.
    return NextResponse.json({
      postId: existing.post_id,
      commentCount: await visibleCommentCount(input.articleKey),
    });
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
    if (winner) {
      return NextResponse.json({
        postId: winner.post_id,
        commentCount: await visibleCommentCount(input.articleKey),
      });
    }
  }
  return NextResponse.json({ error: "failed to link discussion" }, { status: 500 });
}
