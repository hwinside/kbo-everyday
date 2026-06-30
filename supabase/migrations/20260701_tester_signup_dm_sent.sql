-- tester_signups.dm_sent_at: 운영팀이 다운로드 안내 쪽지를 발송한 시각.
-- 어드민 테스터 신청 목록에서 '발송됨' 표시가 화면 임시상태라 페이지 재진입 시 초기화되던 문제를
-- DB에 영구 기록해 해결한다. NULL = 미발송. service_role(서버 API)만 갱신.

ALTER TABLE tester_signups
  ADD COLUMN IF NOT EXISTS dm_sent_at TIMESTAMPTZ;
