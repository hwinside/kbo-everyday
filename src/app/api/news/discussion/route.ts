import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  NewsDiscussionInputError,
  parseNewsDiscussionInput,
  type ParsedNewsDiscussionInput,
} from "@/lib/news/discussion";
import { allowNewsDiscussionRequest } from "@/lib/news/discussion-rate-limit";
import { isNewsDiscussionUser } from "@/lib/news/discussion-auth";
import { ALL_TEAM_SLUGS } from "@/lib/utils/post-scope";

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
  // ensure(브릿지 생성/조회)는 로그인 유저 전용(admin-only 해제 = 전체 로그인 유저,
  // PR #818 선례와 동일 계약). 익명을 열면 rate-limit 안에서 임의 기사 URL 로 post
  // 브릿지를 무한 생성하는 bridge-spam 이 가능하다. 클라 CTA는 미로그인 시 LoginSheet를
  // 선노출해 이 게이트(401)에 도달하지 않게 하고, 작성은 CommentSheet가 다시 막는다.
  if (!(await isNewsDiscussionUser())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
      // 공개범위 — 기사 브리지는 특정 팀 소유가 아니므로 10팀 전부(= 전체구단 공개).
      // DB 트리거가 canonical slug 1개 이상을 요구하며 **board_type 면제는 없다** —
      // board_type 은 클라이언트가 고르는 값이라 면제 자체가 우회로다(삼순 NO-GO 2026-08-07).
      // is_hidden=true 라 피드에는 안 뜼다.
      team_tags: ALL_TEAM_SLUGS,
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
