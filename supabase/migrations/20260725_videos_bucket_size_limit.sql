-- 직관 라이브 (Venue Stories) — 대용량 영상 즉시 승격 실패 근본수정
--
-- [삼순 진단 확정 / spike VALIDATED 2026-07-25]
-- 증상: 20~50MiB 영상이 업로드 후 pending('지연·다시 시도')에 머물고 워커 압축 후에야
--       active 가 된다(수초가 아닌 최대 수십분 지연).
-- 원인: 서버 ffprobe 검증(≤50MiB, ~1.7s)·클라·venue-staging 버킷은 모두 50MiB 를 허용하나,
--       승격 대상인 공개 videos 버킷의 file_size_limit 이 20MiB(20971520)로 남아 있어
--       publishOriginal 이 20MiB 초과 원본을 공개 버킷에 못 올려 pending 잔류.
--       (prod 실증: 43.88MB dry-run ffprobe PASS·200 → full-path 승격 500/faults=1·public object 미생성.
--        2.3MB 는 200·promoted=1·active. 경계가 정확히 20MiB.)
-- 수정: 공개 videos 버킷 file_size_limit 을 앱/staging 계약과 동일한 50MiB(52428800)로 정렬.
--
-- ⚠️ 범위 제한(surgical): file_size_limit 만 갱신. public/allowed_mime_types 등 다른 속성 불변.
--    커뮤니티 UI 20MB 업로드 정책은 앱 계층 검증이라 이 버킷 상향과 무관하게 그대로 유지된다.
-- 멱등: 이미 52428800 이면 no-op.

UPDATE storage.buckets
SET file_size_limit = 52428800 -- 50MiB (VENUE_STORY_MAX_BYTES · venue-staging 버킷과 일치)
WHERE id = 'videos'
  AND file_size_limit IS DISTINCT FROM 52428800;
