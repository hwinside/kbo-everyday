-- ============================================================
-- 크관(GameChat) 본인 채팅 삭제 v1 — PR1 grants hotfix
-- ------------------------------------------------------------
-- 배경:
--   2026-05-27 PR #121 (`179bcd76`) 머지 후 production 실행 시
--   `REVOKE ALL ON FUNCTION ... FROM PUBLIC`만으로는 Supabase 기본
--   `ALTER DEFAULT PRIVILEGES`가 anon/service_role/postgres에 자동
--   부여한 EXECUTE 권한이 회수되지 않음을 확인.
--   삼순이 GO 게이트 #2("authenticated만 EXECUTE")를 충족시키기 위해
--   명시적 REVOKE FROM anon, service_role, PUBLIC을 추가한다.
--
-- 실제 보안 영향:
--   함수 내부 `auth.uid() IS NULL → not_authenticated` 가드 덕에
--   anon이 EXECUTE 권한을 가지고 있어도 실제 삭제는 불가능했음.
--   본 hotfix는 게이트 기준 충족 + 방어 심도용.
--
-- production 적용 시점:
--   Supabase Management API로 본 SQL 내용을 2026-05-27 16:14 KST에
--   직접 실행 완료. 본 파일은 git history sync 목적.
-- ============================================================

REVOKE EXECUTE ON FUNCTION delete_own_chat_message(BIGINT) FROM anon, service_role, PUBLIC;
GRANT  EXECUTE ON FUNCTION delete_own_chat_message(BIGINT) TO authenticated;

-- ============================================================
-- 검증 쿼리 (배포 후):
--   SELECT grantee, privilege_type
--     FROM information_schema.routine_privileges
--    WHERE routine_name = 'delete_own_chat_message'
--    ORDER BY grantee;
--   -- 기대: authenticated/EXECUTE + postgres/EXECUTE(superuser 자동) 만.
-- ============================================================
