import { createSupabaseServer } from "@/lib/supabase/server";

/**
 * 기사 댓글 브릿지 ensure / 네이티브 댓글 오버레이는 로그인 유저에게만 연다.
 * 익명 남용을 막고 모더레이션 추적성을 확보하기 위함이며, 댓글 작성 자체는
 * CommentSheet(user 필수)가 다시 막는다. 카운트 조회는 공개다.
 */
export async function isNewsDiscussionUser(): Promise<boolean> {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return Boolean(user);
}
