-- 운영자 삭제 권한 V1 — 슬라이스 1 (DB 토대)
-- 요청: 2026-06-09 #marketing 하린아빠 — 하린아빠/하린엄마/윤연률에게 모든 글·댓글·채팅 삭제 권한
-- 스펙: specs/community/operator-delete-permissions-v1.md
--
-- 기존(prod) 상태:
--   - profiles.is_operator BOOLEAN 컬럼 존재 (2026-05-30 댓글 운영자삭제 때 추가)
--   - comments: "Operators delete any comments" DELETE 정책 존재 (is_operator 게이트)
--   - posts: 운영자 삭제 정책 없음 (본인 삭제만) → 본 마이그레이션에서 추가
--   - chat_messages: DELETE 정책 없음. soft-delete는 delete_own_chat_message RPC(본인만)
--                    → 운영자용 delete_any_chat_message RPC 추가
--
-- 식별: profiles.is_operator = true (per-user 플래그). 새 운영자는 아래 grant에 UUID 추가.

-- ============================================================
-- 0. profiles.is_operator 컬럼 보장 (멱등)
--    prod엔 이미 존재(2026-05-30 댓글 운영자삭제 PR #145)하나,
--    그 migration이 main 미머지라 클린 환경/main 기준 본 migration 단독 실행 시
--    아래 is_operator 참조가 실패할 수 있음 → IF NOT EXISTS로 선보장.
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_operator BOOLEAN DEFAULT false;
COMMENT ON COLUMN profiles.is_operator IS '운영자 플래그 — 글/댓글/채팅 삭제 권한 게이트';

-- ============================================================
-- 0.5 is_operator 셀프-부여 차단 가드 (권한 상승 방지)
--    문제: profiles RLS "Users update own"이 본인 row 전체 UPDATE를 허용하고
--          Supabase 기본 grant가 authenticated에 테이블 레벨 UPDATE를 줘서,
--          일반 유저가 SDK로 .update({ is_operator: true })를 직접 호출하면
--          posts RLS / delete_any_chat_message 게이트를 셀프로 통과할 수 있음.
--    해결: is_operator 컬럼 변경을 elevated role(마이그레이션/서버) 외에는 차단.
--          앱 updateProfile은 is_operator를 안 건드리므로 정상 흐름 영향 없음.
--          INSERT 경로(신규 row에 is_operator=true)도 동일 차단.
--    트리거는 SECURITY INVOKER(기본)라 current_user가 호출 role을 그대로 반영:
--          PostgREST 일반 유저 = 'authenticated'/'anon', 마이그레이션 = 'postgres'/
--          'supabase_admin', 서버 admin = 'service_role'.
-- ============================================================
CREATE OR REPLACE FUNCTION guard_profiles_is_operator()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('postgres', 'supabase_admin', 'supabase_auth_admin', 'service_role') THEN
    RETURN NEW;  -- 마이그레이션/서버측 admin은 허용
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.is_operator IS TRUE THEN
      RAISE EXCEPTION 'is_operator can only be set by an administrator' USING ERRCODE = '42501';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.is_operator IS DISTINCT FROM OLD.is_operator THEN
      RAISE EXCEPTION 'is_operator can only be changed by an administrator' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profiles_is_operator ON profiles;
CREATE TRIGGER trg_guard_profiles_is_operator
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION guard_profiles_is_operator();

-- ============================================================
-- 1. posts — 운영자 삭제 정책 (comments 정책과 동일 패턴)
--    앱 경로: usePosts.deletePost 가 .delete() 하드삭제 (author_id eq 게이트).
--    운영자는 UI에서 author_id 필터 생략 → 이 RLS 정책이 허용.
-- ============================================================
DROP POLICY IF EXISTS "Operators delete any posts" ON posts;
CREATE POLICY "Operators delete any posts" ON posts
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.is_operator = true
    )
  );

-- ============================================================
-- 2. chat_messages — 운영자 soft-delete RPC
--    delete_own_chat_message(본인) 와 동일 마스킹/구조, 게이트만 is_operator.
--    broad UPDATE 정책 추가 안 함 — SECURITY DEFINER 함수가 유일한 운영자 삭제 경로.
-- ============================================================
CREATE OR REPLACE FUNCTION delete_any_chat_message(p_message_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_is_op  BOOLEAN;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT is_operator INTO v_is_op FROM profiles WHERE id = v_caller;
  IF v_is_op IS NOT TRUE THEN
    RAISE EXCEPTION 'not_operator' USING ERRCODE = '42501';
  END IF;

  UPDATE chat_messages
     SET content    = '삭제된 메시지입니다',
         deleted_at = now(),
         deleted_by = v_caller
   WHERE id = p_message_id
     AND deleted_at IS NULL;     -- redelete 차단

  IF NOT FOUND THEN
    RAISE EXCEPTION 'already_deleted_or_not_found' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- grant hardening: REVOKE ALL ... FROM PUBLIC만으로는 Supabase 기본 grant로
-- anon/service_role에 EXECUTE가 남을 수 있어, delete_own_chat_message hotfix
-- (20260527_gamechat_message_delete_grants_hotfix)와 동일하게 명시 revoke.
REVOKE ALL    ON FUNCTION delete_any_chat_message(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_any_chat_message(BIGINT) FROM anon, service_role, PUBLIC;
GRANT  EXECUTE ON FUNCTION delete_any_chat_message(BIGINT) TO authenticated;

-- ============================================================
-- 3. 운영자 권한 부여 (멱등) — 하린아빠 / 하린엄마 / 윤연률
--    2026-06-09 하린아빠 확정. 정배현우·김현우는 제외(권한 미부여).
-- ============================================================
UPDATE profiles SET is_operator = true
WHERE id IN (
  '04f1fcff-6173-4dda-920a-e5f8ff66a696',  -- 하린아빠 (harinclaw@gmail.com)
  '256c43ce-9a44-4c3e-9eb6-6bf64378bb4a',  -- 하린엄마 (LG사랑해)
  '9cba194d-686d-4d17-b5ac-185b34bc2dc6'   -- 윤연률 (yoonyeonryul@gmail.com)
);
