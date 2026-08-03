-- user_badges 쓰기 경로를 service-role(운영 수여) 전용으로 fail-close 한다.
--
-- 배경: 기존 RLS INSERT 정책 "Users earn badges"는 `auth.uid() = user_id` 만 검사했고
-- badge_id 허용값 제약/trigger 가 없었다. 따라서 로그인 사용자가 브라우저에서 Supabase REST 로
-- 자기 user_id 에 임의 badge_id(`chairman`, `chairman-spouse` 등 한정 수여 배지 포함)를 직접
-- INSERT 할 수 있었고, 프로필은 user_badges 를 그대로 신뢰하므로 자가 수여가 그대로 노출됐다.
--
-- 실제 수여 경로는 전부 service role 이다:
--   - src/lib/supabase/badge-engine.ts (supabaseAdmin)
--   - src/app/api/setup/route.ts / src/app/api/invite/use/route.ts (admin 클라이언트)
--   - scripts/award-event-badges.mjs, scripts/batch-badge-check.mjs (service role)
-- 클라이언트에서 user_badges 에 직접 쓰는 코드는 없다(SELECT 만 사용).
-- 따라서 anon/authenticated 의 쓰기 권한을 회수해도 정상 배지 획득 경로는 회귀하지 않는다.
--
-- badge_id CHECK 제약을 쓰지 않는 이유: 제약은 service_role 에도 적용되어 운영 수여까지 막고,
-- 새 배지를 추가할 때마다 DB 마이그레이션이 강제된다. 권한 경계에서 닫는 편이 정확하다.

-- 1) 자가 수여 INSERT 정책 제거 (남아 있으면 grant 회수만으로는 의도가 불명확해진다)
DROP POLICY IF EXISTS "Users earn badges" ON public.user_badges;

-- 2) 일반 역할의 쓰기 권한 회수 (UPDATE/DELETE 는 정책이 없어 이미 RLS 로 막혀 있었지만,
--    grant 자체를 회수해 권한 경계를 이중으로 닫는다)
REVOKE INSERT, UPDATE, DELETE ON public.user_badges FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.user_badges FROM authenticated;

-- 3) 공개 조회는 유지 (프로필 배지 노출은 anon 경로로 읽는다)
--    기존 정책 "Anyone reads badges" (SELECT USING true) 는 그대로 둔다.

COMMENT ON TABLE public.user_badges IS
  '유저 배지 보유 원장. 쓰기는 service-role(운영 수여) 전용 — anon/authenticated 직접 INSERT/UPDATE/DELETE 는 fail-close. 읽기는 공개.';
