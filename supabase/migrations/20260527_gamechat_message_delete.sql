-- ============================================================
-- 크관(GameChat) 본인 채팅 삭제 v1 — PR1 (DB migration + RPC)
-- ------------------------------------------------------------
-- 스펙: specs/community/gamechat-message-delete-v1.md (v3, 2026-05-26)
-- 삼순이 GO 게이트: "RLS 우회 불가 + public SELECT 원문 미노출"
-- ============================================================

-- 1. 컬럼 추가 (idempotent)
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES profiles(id) ON DELETE SET NULL;

-- 2. 본인 삭제 RPC
-- broad UPDATE 정책은 추가하지 않음. SECURITY DEFINER 함수가 유일한 삭제 경로.
-- 함수 내부에서 auth.uid() = user_id, deleted_at IS NULL, content 마스킹을 원자적으로 처리.
CREATE OR REPLACE FUNCTION delete_own_chat_message(p_message_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  UPDATE chat_messages
     SET content    = '삭제된 메시지입니다',
         deleted_at = now(),
         deleted_by = v_caller
   WHERE id = p_message_id
     AND user_id = v_caller         -- 본인 메시지만
     AND deleted_at IS NULL;        -- undelete/redelete 차단

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_owner_or_already_deleted' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- 3. 권한 — 함수 호출은 authenticated에게만. anon 차단.
REVOKE ALL ON FUNCTION delete_own_chat_message(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_own_chat_message(BIGINT) TO authenticated;

-- ============================================================
-- 배포 후 검증 체크리스트 (삼순이 GO 조건 4건)
-- ------------------------------------------------------------
-- ✅ #1 SECURITY DEFINER 소유자 확인:
--    SELECT proname, prosecdef, proowner::regrole
--      FROM pg_proc WHERE proname = 'delete_own_chat_message';
--
-- ✅ #2 GRANT authenticated만 열렸는지:
--    SELECT grantee, privilege_type
--      FROM information_schema.routine_privileges
--     WHERE routine_name = 'delete_own_chat_message';
--    -- 기대: grantee=authenticated, privilege_type=EXECUTE 단일 row.
--
-- ✅ #3 anon 키로 직접 UPDATE 시도 → RLS error 또는 0 rows:
--    (anon 클라에서 supabase.from('chat_messages').update({...}).eq('id', X))
--
-- ✅ #4 삭제 후 anon SELECT 원문 미노출:
--    (anon 클라에서 select * from chat_messages where id = <삭제된 id>
--     → content = '삭제된 메시지입니다')
-- ============================================================
