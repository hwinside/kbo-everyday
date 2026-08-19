import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest, confirmEmailPrivilege } from "@/lib/auth/verified-user";
import { isAdminEmail } from "@/lib/admin/admin-users";
import { canDeleteComment } from "@/lib/venue-stories/comments";

// DELETE: 스토리 댓글 soft delete (본인 또는 관리자)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> },
) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { id, commentId } = await params;
  const storyId = Number(id);
  const cid = Number(commentId);
  if (!Number.isInteger(storyId) || !Number.isInteger(cid)) {
    return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
  }

  const { data: row, error: fetchErr } = await supabase
    .from("venue_story_comments")
    .select("id, story_id, user_id, deleted_at")
    .eq("id", cid)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
  if (!row || row.story_id !== storyId || row.deleted_at != null) {
    return NextResponse.json({ error: "없는 댓글" }, { status: 404 });
  }

  const allowed = canDeleteComment(
    row.user_id as string,
    verified.user.id,
    // 타인 댓글 삭제 권한이 갈리는 지점 → 서버 권위 확인(삼순 필수③).
    await confirmEmailPrivilege(verified.user.email, verified.token, isAdminEmail),
  );
  if (!allowed) {
    return NextResponse.json({ error: "본인 댓글만 삭제할 수 있어요" }, { status: 403 });
  }

  const { error: delErr } = await supabase
    .from("venue_story_comments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", cid)
    .is("deleted_at", null);
  if (delErr) {
    return NextResponse.json({ error: "삭제 실패" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
