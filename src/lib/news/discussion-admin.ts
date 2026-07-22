import { isAdminEmail } from "@/lib/admin/admin-users";
import { createSupabaseServer } from "@/lib/supabase/server";

/** 기사 댓글은 prod QA가 끝날 때까지 관리자에게만 연다. */
export async function isNewsDiscussionAdmin(): Promise<boolean> {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminEmail(user?.email);
}
