import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { checkAndAwardBadges } from "./badge-engine";

/**
 * 초대 활성화 체크.
 * 초대받은 유저가 팀 선택 + 첫 글/댓글 작성 시 호출.
 * 조건 충족 시 invitations.activated_at 기록 + inviter 뱃지 체크.
 */
export async function checkAndActivateInvite(userId: string): Promise<void> {
  // 프로필 조회 (team_id, invited_by)
  const { data: profile } = await supabase
    .from("profiles")
    .select("team_id, invited_by")
    .eq("id", userId)
    .single();

  if (!profile?.invited_by) return; // 초대로 가입 안 한 유저
  if (!profile.team_id) return; // 팀 미선택

  // 이미 활성화된 초대가 있는지 체크
  const { data: invitation } = await supabase
    .from("invitations")
    .select("id, inviter_id")
    .eq("invitee_id", userId)
    .is("activated_at", null)
    .single();

  if (!invitation) return; // 이미 활성화됨 또는 초대 없음

  // 글 + 댓글 합계 1 이상 체크
  const { count: postCount } = await supabase
    .from("posts")
    .select("*", { count: "exact", head: true })
    .eq("author_id", userId);

  const { count: commentCount } = await supabase
    .from("comments")
    .select("*", { count: "exact", head: true })
    .eq("author_id", userId);

  const totalActivity = (postCount || 0) + (commentCount || 0);
  if (totalActivity < 1) return;

  // 활성화 처리
  await supabase
    .from("invitations")
    .update({ activated_at: new Date().toISOString() })
    .eq("id", invitation.id);

  // inviter 뱃지 체크
  await checkAndAwardBadges(invitation.inviter_id);
}
