-- 게시글 조회수(관리자 전용 노출) 슬라이스 1 — DB 토대
-- 요청: 2026-07-21 #cs 하린아빠 — "관리자 id만 볼 수 있게 조회수 카운트"
--   조회수 = ①상세 클릭 진입 카운트 + ②커뮤 피드에서 카드 세로 ≥50% 노출 시 +1(임프레션)
--   표시 게이트는 클라(ADMIN_EMAILS)에서만; 카운트 증가 자체는 전체 유저 대상(공개).
--
-- 설계:
--   - posts에 click_view_count / impression_view_count 2컬럼(누적 카운터).
--   - increment_post_view(p_post_id, p_kind) RPC(SECURITY DEFINER)로만 증가.
--     · 일반 유저는 posts UPDATE 권한이 없으므로(카운터 임의 조작 방지) RPC 경유.
--     · anon/authenticated 모두 실행 허용(비로그인 임프레션/클릭도 집계).
--   - 중복 방지(세션당 1회 임프레션 등)는 클라에서 수행. 서버는 순수 증가만.

-- ============================================================
-- 1. 카운터 컬럼 (멱등)
-- ============================================================
ALTER TABLE posts ADD COLUMN IF NOT EXISTS click_view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS impression_view_count INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN posts.click_view_count IS '조회수 — 상세 진입(클릭) 누적. 2026-07-21 관리자 전용 노출.';
COMMENT ON COLUMN posts.impression_view_count IS '조회수 — 피드 임프레션(카드 세로 50%+ 노출) 누적. 2026-07-21 관리자 전용 노출.';

-- ============================================================
-- 2. 증가 RPC (SECURITY DEFINER — 카운터만 원자적으로 +1)
--    p_kind: 'click' | 'impression'. 그 외 값은 no-op(방어).
-- ============================================================
CREATE OR REPLACE FUNCTION increment_post_view(p_post_id BIGINT, p_kind TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_kind = 'click' THEN
    UPDATE posts SET click_view_count = click_view_count + 1 WHERE id = p_post_id;
  ELSIF p_kind = 'impression' THEN
    UPDATE posts SET impression_view_count = impression_view_count + 1 WHERE id = p_post_id;
  END IF;
  -- 그 외 kind 또는 없는 post_id는 조용히 무시(집계 실패가 UX를 막지 않도록).
END;
$$;

REVOKE ALL ON FUNCTION increment_post_view(BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION increment_post_view(BIGINT, TEXT) TO anon, authenticated, service_role;
