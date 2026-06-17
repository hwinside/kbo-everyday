-- 홈 숏츠 섹션 사용자별 on/off 설정. 기본 ON으로 기존 경험을 유지한다.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS show_shorts boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.profiles.show_shorts IS '마이페이지 숏츠 보기 토글. false면 홈 숏츠 섹션을 숨긴다.';
