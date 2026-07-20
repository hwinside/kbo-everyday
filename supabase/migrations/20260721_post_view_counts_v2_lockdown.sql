-- 게시글 조회수 v2 — RPC 권한 잠금(삼순 blocker 3, 2026-07-21)
--
-- 문제: v1(20260721_post_view_counts.sql)이 increment_post_view RPC를
--       anon/authenticated에도 EXECUTE 부여 → 클라가 Supabase REST로 RPC를 직접
--       반복 호출해 내부 지표를 임의 오염시킬 수 있음. 서버 route는 service_role로
--       호출하므로 이 grant는 불필요.
-- 해결: PUBLIC·anon·authenticated EXECUTE revoke, service_role만 유지.
--       (v1은 이미 prod 적용됨 → amend 아닌 forward v2로 보정)

REVOKE ALL ON FUNCTION increment_post_view(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_post_view(BIGINT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION increment_post_view(BIGINT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_post_view(BIGINT, TEXT) TO service_role;
