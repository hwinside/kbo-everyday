import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import {
  validateCommentContent,
  toChronological,
  isStoryOpenForComments,
  VENUE_STORY_COMMENT_LIST_LIMIT,
  type VenueStoryComment,
} from "@/lib/venue-stories/comments";
import { normalizeForFloodKey } from "@/lib/utils/normalize-message";

function parseStoryId(id: string): number | null {
  const storyId = Number(id);
  return Number.isInteger(storyId) ? storyId : null;
}

/** 수명주기 게이트(GET/POST 공용) — active + 미만료 스토리만 댓글 조회/작성 허용 */
async function loadOpenStory(storyId: number) {
  const { data: story, error } = await supabase
    .from("venue_stories")
    .select("id, status, expires_at")
    .eq("id", storyId)
    .maybeSingle();
  if (error) return { error: true as const, open: false };
  return { error: false as const, open: isStoryOpenForComments(story) };
}

async function buildAuthorMap(userIds: string[]) {
  const map = new Map<
    string,
    { nickname: string | null; avatarUrl: string | null; teamId: number | null }
  >();
  if (userIds.length === 0) return map;
  // query-guard: bounded -- 댓글 목록 상한(100)에서 나온 유저 id IN 조회로 최대 100행
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, nickname, avatar_url, team_id")
    .in("id", userIds);
  for (const p of profiles ?? []) {
    map.set(p.id as string, {
      nickname: (p.nickname as string) ?? null,
      avatarUrl: (p.avatar_url as string) ?? null,
      teamId: (p.team_id as number) ?? null,
    });
  }
  return map;
}

// GET: 스토리 댓글 목록(미삭제 최신 100개를 정순 반전 — 채팅처럼 아래로 쌓임) + 총 개수(total)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const storyId = parseStoryId(id);
  if (storyId == null) {
    return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
  }

  // 비활성·만료 스토리의 댓글은 GET 도 닫는다(삼순 #807 blocker 2 — POST 와 동일 게이트)
  const gate = await loadOpenStory(storyId);
  if (gate.error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
  if (!gate.open) {
    return NextResponse.json({ error: "없는 스토리" }, { status: 404 });
  }

  // 101개 이상이어도 "최신 100개"가 보이도록 DESC 로 자르고 응답에서 정순 반전.
  // 총 개수는 head count 로 분리해 total 필드로 내려줌(UI 개수 표시용).
  const [listRes, countRes] = await Promise.all([
    // query-guard: bounded -- 스토리당 댓글은 최신 100개 UI 목록만 제공한다
    supabase
      .from("venue_story_comments")
      .select("id, story_id, user_id, content, created_at")
      .eq("story_id", storyId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(VENUE_STORY_COMMENT_LIST_LIMIT),
    // query-guard: bounded -- head:true 카운트 전용(행 전송 없음)
    supabase
      .from("venue_story_comments")
      .select("id", { count: "exact", head: true })
      .eq("story_id", storyId)
      .is("deleted_at", null),
  ]);

  if (listRes.error || countRes.error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  const list = toChronological(listRes.data ?? []);
  const authorMap = await buildAuthorMap([
    ...new Set(list.map((r) => r.user_id as string)),
  ]);

  const comments: VenueStoryComment[] = list.map((r) => ({
    id: r.id as number,
    storyId: r.story_id as number,
    userId: r.user_id as string,
    content: r.content as string,
    createdAt: r.created_at as string,
    author:
      authorMap.get(r.user_id as string) ?? {
        nickname: null,
        avatarUrl: null,
        teamId: null,
      },
  }));

  return NextResponse.json({ comments, total: countRes.count ?? comments.length });
}

// POST: 댓글 작성 (로그인 필수, active 스토리에만)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { id } = await params;
  const storyId = parseStoryId(id);
  if (storyId == null) {
    return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }
  const check = validateCommentContent((body as { content?: unknown })?.content);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  // 원자화 RPC(삼순 #807 라운드3 blocker 1) — 스토리 active/만료 게이트 +
  // 10초 간격/60초 내 3건/동일내용(최근 5건) 판정 + INSERT 를 유저별
  // advisory xact lock 안 단일 트랜잭션으로 수행 — 동시 POST 가 같은 빈
  // snapshot 을 읽고 둘 다 통과하는 경쟁을 막는다. 판정 참조 구현은
  // evaluateCommentAbuse(comments.ts) — 상수/경계 동일 계약을 스모크가 검증한다.
  const contentKey = normalizeForFloodKey(check.content) || check.content;
  // query-guard: bounded -- 단일 jsonb 결과(댓글 1건 또는 오류 코드)만 반환하는 RPC
  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    "venue_story_comment_post",
    {
      p_story_id: storyId,
      p_user_id: verified.user.id,
      p_content: check.content,
      p_content_key: contentKey,
    },
  );
  if (rpcErr || !rpcData) {
    return NextResponse.json({ error: "작성 실패" }, { status: 500 });
  }
  const result = rpcData as {
    ok: boolean;
    error?: string;
    comment?: {
      id: number;
      story_id: number;
      user_id: string;
      content: string;
      created_at: string;
    };
  };
  if (!result.ok || !result.comment) {
    if (result.error === "not_found") {
      return NextResponse.json({ error: "없는 스토리" }, { status: 404 });
    }
    if (result.error === "duplicate") {
      return NextResponse.json(
        { error: "같은 댓글은 반복해서 달 수 없어요" },
        { status: 429 },
      );
    }
    if (result.error === "rate") {
      return NextResponse.json(
        { error: "잠시 후 다시 입력해 주세요" },
        { status: 429 },
      );
    }
    return NextResponse.json({ error: "작성 실패" }, { status: 500 });
  }
  const inserted = result.comment;

  const authorMap = await buildAuthorMap([verified.user.id]);
  const comment: VenueStoryComment = {
    id: inserted.id as number,
    storyId: inserted.story_id as number,
    userId: inserted.user_id as string,
    content: inserted.content as string,
    createdAt: inserted.created_at as string,
    author:
      authorMap.get(verified.user.id) ?? {
        nickname: null,
        avatarUrl: null,
        teamId: null,
      },
  };

  return NextResponse.json({ comment });
}
