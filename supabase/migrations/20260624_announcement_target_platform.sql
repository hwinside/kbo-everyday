-- 새소식(announcements)에 노출 대상 플랫폼 컬럼 추가 + 안드로이드 테스터 모집 공지 시드
-- target_platform: 'all'(전체) | 'android_web'(안드로이드 모바일웹 전용 — 설치된 네이티브 앱/iOS 제외)
--   * 비공개 테스트 신규 모집 대상 = 아직 앱이 아니라 웹에서 보는 안드로이드 유저.
--   * 설치된 앱 유저는 이미 테스터, iOS는 안드 테스트 참여 불가 → 둘 다 클라이언트에서 제외.

ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS target_platform TEXT NOT NULL DEFAULT 'all';

ALTER TABLE announcements
  DROP CONSTRAINT IF EXISTS announcements_target_platform_check;
ALTER TABLE announcements
  ADD CONSTRAINT announcements_target_platform_check
  CHECK (target_platform IN ('all', 'android_web'));

-- 안드로이드 테스터 모집 공지 (안드 모바일웹에만 노출). 고정 UUID로 멱등 시드.
INSERT INTO announcements (id, title, summary, body, cta_label, cta_path, target_platform, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000624',
  '🎟️ 크보팬 안드로이드 테스터 모집',
  '크보팬 안드로이드 앱을 먼저 써보고 피드백 주실 테스터를 찾아요!',
  E'크보팬을 안드로이드 앱으로 먼저 만나보세요 ⚾\n\n지금 크보팬은 비공개 테스트 중이에요. 앱을 직접 써보시고 좋은 점·아쉬운 점·버그를 알려주실 테스터를 모집합니다.\n\n📋 신청 방법\n1. 아래 ''테스터 신청하기'' 버튼을 누르세요\n2. 구글 플레이스토어에 로그인된 Gmail 주소를 입력하면 끝!\n\n신청해주시면 순차적으로 테스터로 등록해드려요. 등록이 완료되면 플레이스토어에서 크보팬 앱을 설치하실 수 있습니다.\n\n여러분의 피드백이 크보팬을 더 좋게 만듭니다. 많은 참여 부탁드려요! 🙏',
  '테스터 신청하기',
  '/tester-signup',
  'android_web',
  true
)
ON CONFLICT (id) DO NOTHING;
