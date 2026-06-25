-- 새소식 노출 대상에 'ios_web' 추가 (iOS 모바일웹/PWA 전용 — 설치된 네이티브 앱/안드 제외)
--   * iOS 정식 출시 공지 대상 = 아직 앱이 아니라 웹/PWA로 보는 iOS 유저.
--   * 설치된 앱 유저는 이미 받았고, 안드/데스크톱은 앱스토어 대상이 아님 → 클라이언트에서 제외.
-- 공지 본문/CTA(앱스토어 URL)는 앱 라이브 시점에 어드민에서 생성·활성화 (여기서 시드하지 않음).

ALTER TABLE announcements
  DROP CONSTRAINT IF EXISTS announcements_target_platform_check;
ALTER TABLE announcements
  ADD CONSTRAINT announcements_target_platform_check
  CHECK (target_platform IN ('all', 'android_web', 'ios_web'));

-- cta_path 제약 완화: 기존 컬럼 인라인 CHECK(announcements_cta_path_check, 20260428)는
-- 내부 경로('/...')만 허용 → App Store 등 외부 https URL insert/update 시 DB에서 거부(500).
-- 내부 경로 OR https:// 외부 URL 둘 다 허용하도록 교체 (javascript:/http:/// 는 계속 차단).
ALTER TABLE announcements
  DROP CONSTRAINT IF EXISTS announcements_cta_path_check;
ALTER TABLE announcements
  ADD CONSTRAINT announcements_cta_path_check
  CHECK (
    cta_path IS NULL
    OR cta_path ~ '^/[A-Za-z0-9/_?=&%#.-]*$'
    OR cta_path ~ '^https://[^[:space:]]+$'
  );
