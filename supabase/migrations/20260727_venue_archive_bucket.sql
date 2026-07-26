-- 직관 다이어리 미디어 보관(archive) — S2 Blocker 1: private archive 버킷
--
-- 배경(삼순 NO-GO): videos/photos 공개 버킷은 public=true 라, S1 이 archived 로 status 만 바꿔도
-- 원본/썸네일은 여전히 `/storage/v1/object/public/...` 로 무인증 접근된다(공개 시점 URL 을 저장한
-- 타인이 만료 후에도 열람 가능). 확정 정책 `🔒 나만 보기`·"만료 후 미노출"·S2 signed URL 계약 위반.
--
-- 조치(A안, 하린아빠 승인): archived 전환 시 원본/썸네일을 **private** venue-archive 버킷으로 이동하고
-- (cleanup route 가 copy→DB update→원본 remove 순서로 수행), 다이어리 API 는 본인 인증 후 짧은
-- signed URL 만 발급한다. 이 migration 은 그 대상 버킷을 만든다.
--
-- 멱등: INSERT ... ON CONFLICT (id) DO NOTHING. 이미 있으면 no-op(속성 덮어쓰지 않음).
-- prod 선적용 금지(리뷰·머지 게이트 통과 후 적용).

-- ── private archive 버킷 ────────────────────────────────────────────
-- public=false(무인증 공개 URL 없음). file_size_limit 은 앱/staging/videos 계약과 동일 50MiB.
-- allowed_mime_types 는 원본(영상/사진) + 썸네일(이미지) 을 모두 수용.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'venue-archive',
  'venue-archive',
  false,
  52428800, -- 50MiB (VENUE_STORY_MAX_BYTES · videos/venue-staging 버킷과 일치)
  ARRAY[
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
    'image/jpeg', 'image/png', 'image/webp'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── storage RLS: 공개 정책 없음 = service_role 전용 ─────────────────
-- SELECT/INSERT/UPDATE/DELETE 정책을 하나도 만들지 않는다 → authenticated/anon 직접 접근 불가(private).
-- copy(이동)·remove·signed URL 발급은 전부 service_role(cleanup cron·다이어리 API, RLS bypass)이 수행한다.
-- (staging 버킷과 달리 클라 직접 업로드 경로가 없으므로 INSERT own 정책도 두지 않는다.)
