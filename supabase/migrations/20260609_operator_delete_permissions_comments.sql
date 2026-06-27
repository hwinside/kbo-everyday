-- 운영자 댓글 삭제 정책 (comments) — S1(20260609_operator_delete_permissions) 후속
-- 요청: 2026-06-09 #marketing 하린아빠 — 운영자에게 댓글 삭제 권한
--
-- 배경:
--   - 본 정책은 원래 2026-05-30 migration(20260530_operator_comment_delete)에 있었으나,
--     PR #200(S1, 20260609_operator_delete_permissions)이 먼저 prod 적용된 뒤라
--     과거 timestamp(20260530)로 새로 들어오면 prod migration history에서
--     "나중에 들어온 과거 migration"이 되어 supabase db push/운영 적용이 꼬일 수 있음.
--     → 최신 날짜로 재발급하고, 클린 환경 정렬상 S1 뒤에 적용되도록
--       파일명을 20260609_operator_delete_permissions_comments 로 둠
--       (정렬: ..._permissions.sql < ..._permissions_comments.sql).
--   - profiles.is_operator 컬럼/COMMENT 및 셀프-부여 가드 트리거는 S1에서 이미 보장하므로
--     여기서는 comments DELETE 정책만 둔다 (중복 제거).
--
-- 식별: profiles.is_operator = true (per-user 플래그, S1과 동일 게이트)

DROP POLICY IF EXISTS "Operators delete any comments" ON comments;
CREATE POLICY "Operators delete any comments" ON comments
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM profiles p
      WHERE p.id = auth.uid()
        AND p.is_operator = true
    )
  );
