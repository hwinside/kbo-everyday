-- 콘텐츠 조회수 (숏츠·뉴스 기사) — 2026-08-14
--
-- 표시(관리자 전용)는 클라 게이트(ADMIN_EMAILS)에서 처리, 여기선 순수 집계만.
-- 게시글 조회수(increment_post_view, 20260721 v1+v2)와 동일 계약:
--   - 증가는 서버 route(service_role)만 가능 (anon/authenticated EXECUTE 없음)
--   - 테이블 직접 쓰기도 service_role만 (RLS: 클라 read/write 전면 차단 —
--     count 조회도 서버 route 경유라 클라 정책이 필요 없다)

CREATE TABLE IF NOT EXISTS content_views (
  content_type TEXT NOT NULL CHECK (content_type IN ('shorts', 'news')),
  content_id   TEXT NOT NULL CHECK (char_length(content_id) BETWEEN 1 AND 512),
  view_count   BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_type, content_id)
);

ALTER TABLE content_views ENABLE ROW LEVEL SECURITY;
-- 정책 없음 = anon/authenticated 전면 차단. service_role은 RLS 우회.

CREATE OR REPLACE FUNCTION increment_content_view(p_content_type TEXT, p_content_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_content_type NOT IN ('shorts', 'news') THEN
    RAISE EXCEPTION 'invalid content_type: %', p_content_type;
  END IF;
  IF p_content_id IS NULL OR char_length(p_content_id) < 1 OR char_length(p_content_id) > 512 THEN
    RAISE EXCEPTION 'invalid content_id';
  END IF;

  INSERT INTO content_views (content_type, content_id, view_count, updated_at)
  VALUES (p_content_type, p_content_id, 1, now())
  ON CONFLICT (content_type, content_id)
  DO UPDATE SET view_count = content_views.view_count + 1, updated_at = now();
END;
$$;

-- RPC 권한 잠금 — service_role only (20260721 v2 lockdown과 동일 계약)
REVOKE ALL ON FUNCTION increment_content_view(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_content_view(TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION increment_content_view(TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_content_view(TEXT, TEXT) TO service_role;
