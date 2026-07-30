-- P0: 계정삭제(공식 탈퇴) Production 500 수정.
--
-- auth.admin.deleteUser 가 auth.users 를 지우면 comments/likes 가 FK CASCADE 로
-- 삭제되고, 그 때 AFTER DELETE 트리거 update_comment_count / update_like_count 가
-- 발화한다. 두 함수는 SECURITY DEFINER 인데 search_path 를 고정하지 않아,
-- auth admin(supabase_auth_admin) 컨텍스트처럼 search_path 에 public 이 없는
-- 세션에서는 unqualified `posts` 참조가 42P01(relation "posts" does not exist)로
-- 깨져 탈퇴 전체가 500 으로 실패했다.
--
-- 수정: 본문 로직은 그대로 두고
--   1) SET search_path = public, pg_temp 고정
--   2) 참조 테이블 전부 public. 스키마 한정
-- (트리거 재생성 불필요 — CREATE OR REPLACE 는 기존 트리거 바인딩을 유지한다.)

CREATE OR REPLACE FUNCTION public.update_like_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.posts SET like_count = like_count - 1 WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.update_comment_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.posts SET comment_count = comment_count - 1 WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
