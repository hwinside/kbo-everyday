-- 계정삭제 실패 P0 수정 (2026-07-30, feedback:0563cc52)
--
-- 근본원인: update_comment_count / update_like_count / update_comment_like_count
-- 트리거 함수가 SECURITY DEFINER인데 SET search_path가 없어 호출 세션의
-- search_path를 상속한다. GoTrue(supabase_auth_admin)가 auth.users를 삭제하면
-- 유저 댓글/좋아요가 cascade 삭제되며 이 트리거들이 발화하는데, auth 세션의
-- search_path에는 public이 없어 unqualified `posts`/`comments` 참조가
-- `relation "posts" does not exist`로 실패 → 계정 삭제 전체 롤백.
-- (프로덕션 postgres_logs 실증: user_name=supabase_auth_admin,
--  query=DELETE FROM "users", context=update_comment_count() line 7)
--
-- 수정: 세 함수에 search_path=public 고정 (본문 무변경, surgical).
-- 참고: poll_* 트리거 함수들은 이미 search_path=public 설정돼 있어 무영향.

ALTER FUNCTION public.update_comment_count() SET search_path = public;
ALTER FUNCTION public.update_like_count() SET search_path = public;
ALTER FUNCTION public.update_comment_like_count() SET search_path = public;
