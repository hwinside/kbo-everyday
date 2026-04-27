-- announcements 테이블 (새 소식 공지)
CREATE TABLE IF NOT EXISTS announcements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,            -- 홈 카드용 한줄 카피
  body TEXT NOT NULL,               -- 상세 페이지 마크다운
  cta_label TEXT,                   -- CTA 버튼 텍스트
  cta_path TEXT CHECK (cta_path IS NULL OR cta_path ~ '^/[A-Za-z0-9/_?=&%#.-]*$'),  -- 내부 경로만 허용 (//evil.com 차단)
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  display_until TIMESTAMPTZ,        -- NULL이면 무기한, 값 있으면 자동 숨김
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_announcements_active
  ON announcements(is_active, published_at DESC)
  WHERE is_active = true;

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

-- 모든 유저 읽기 가능
CREATE POLICY "Anyone can read active announcements"
  ON announcements FOR SELECT
  USING (is_active = true AND (display_until IS NULL OR display_until > now()));

-- service_role 전체 접근 (admin API용)
CREATE POLICY "Service role full access on announcements"
  ON announcements FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
