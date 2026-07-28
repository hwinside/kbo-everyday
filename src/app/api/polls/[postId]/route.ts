import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { fetchPollCore, fetchMySelection } from "@/lib/community/poll";
import { checkObjectionableContent } from "@/lib/moderation/content-filter";

// 투표글 편집 서버 계약 상한(생성 create_poll·WritePoll UI 와 동일).
const POLL_TITLE_MAX = 200;
const POLL_CONTENT_MAX = 2000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/polls/[postId] — 투표 상세 (spec §4, §5, §10-3)
 *
 * canSeeResults = voted ∥ closed. 이 조건에서만 선지별 vote_count 노출,
 * 아니면 voter_count(참여수)만. mySelection 이 담긴 유저별 응답은 마감 후에도
 * `Cache-Control: private, no-store` (CDN/프록시 공유 캐시 차단).
 *
 * 인증은 선택: 비로그인/미투표·진행중이면 결과 숨김. 마감 후엔 전원 열람.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid postId" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const core = await fetchPollCore(admin, id);
  if (!core) {
    return NextResponse.json({ error: "투표를 찾을 수 없습니다" }, { status: 404 });
  }

  // 인증은 선택. 있으면 mySelection/voted 판정에 사용.
  const verified = await getVerifiedUserFromRequest(request);
  const mySelection = verified ? await fetchMySelection(admin, id, verified.user.id) : [];
  const voted = mySelection.length > 0;
  const canSeeResults = voted || core.closed;

  const options = core.options.map((o) => ({
    id: o.id,
    position: o.position,
    kind: o.kind,
    refId: o.refId,
    label: o.label,
    image: o.image,
    // 결과 게이트: 진행중·미투표면 수치 은닉
    voteCount: canSeeResults ? o.voteCount : null,
  }));

  const bodyPayload = {
    postId: core.postId,
    title: core.title,
    content: core.content,
    allowMultiple: core.allowMultiple,
    closesAt: core.closesAt,
    closed: core.closed,
    voterCount: core.voterCount, // 항상 공개 (n명 참여)
    canSeeResults,
    voted,
    mySelection, // 유저별 → 응답은 private,no-store
    options,
  };

  const res = NextResponse.json(bodyPayload);
  // §10-3: mySelection 담긴 유저별 응답은 마감 후에도 공유 캐시 금지
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

/**
 * PATCH /api/polls/[postId] — 투표글 질문(title)·설명(content)만 수정 (삼순 NO-GO 반영)
 *
 * "질문·설명만 수정" 계약을 서버에서 강제한다(클라이언트 검증 우회 방어):
 *   1. 인증(Bearer) + 작성자 본인만(403). poll 글이 아니면 404.
 *   2. 질문 필수 + title<=200 + content<=2000 (400).
 *   3. 모더레이션(checkObjectionableContent) — 생성 route 와 동일 계층(400).
 *   4. title/content 만 UPDATE(비텍스트 필드는 payload 자체에 미포함). 선지·마감·태그·
 *      미디어 불변은 DB 트리거 poll_posts_edit_lock() 가 최종 backstop(직접 SDK 우회 포함).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid postId" }, { status: 400 });
  }

  const verified = await getVerifiedUserFromRequest(request);
  if (!verified) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }

  let body: { title?: unknown; content?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "질문(title)은 필수입니다" }, { status: 400 });
  }
  if (title.length > POLL_TITLE_MAX) {
    return NextResponse.json({ error: `질문은 ${POLL_TITLE_MAX}자 이하여야 합니다` }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content : "";
  if (content.length > POLL_CONTENT_MAX) {
    return NextResponse.json({ error: `설명은 ${POLL_CONTENT_MAX}자 이하여야 합니다` }, { status: 400 });
  }

  const moderation = checkObjectionableContent({ title, content });
  if (!moderation.allowed) {
    return NextResponse.json(
      { error: moderation.issues[0] ?? "부적절한 콘텐츠입니다" },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();

  // poll 글 + 작성자 본인 확인. board_type='poll' 아니면 404(이 엔드포인트는 투표글 전용).
  const { data: existing, error: loadErr } = await admin
    .from("posts")
    .select("id, author_id, board_type")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json({ error: "수정에 실패했습니다" }, { status: 500 });
  }
  if (!existing || existing.board_type !== "poll") {
    return NextResponse.json({ error: "투표를 찾을 수 없습니다" }, { status: 404 });
  }
  if (existing.author_id !== verified.user.id) {
    return NextResponse.json({ error: "본인 글만 수정할 수 있습니다" }, { status: 403 });
  }

  // title/content 만 갱신. 비텍스트 필드는 payload 에 없음 → 트리거 불변 가드 통과.
  // (직접 SDK 로 비텍스트 필드를 바꾸려는 우회는 트리거가 23514 로 거부.)
  const { error: updErr } = await admin
    .from("posts")
    .update({ title, content, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("author_id", verified.user.id);
  if (updErr) {
    // 트리거(check_violation) 등 계약 위반은 사용자 입력 문제로 400.
    const status = updErr.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: "투표 수정에 실패했습니다" }, { status });
  }

  return NextResponse.json({ ok: true, title, content });
}
