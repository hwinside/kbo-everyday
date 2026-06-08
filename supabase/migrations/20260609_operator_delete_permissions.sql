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

REVOKE ALL ON FUNCTION delete_any_chat_message(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_any_chat_message(BIGINT) TO authenticated;

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
