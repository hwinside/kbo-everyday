-- 직관 라이브 (Venue Stories) — A안 슬라이스 A1: venue story 전용 private 미디어 버킷.
--
-- ⚠️ prod 미적용 상태(머지 게이트 통과 후 적용).
--
-- A안(하린아빠 승인) 배경:
--  기존엔 미디어가 공개 버킷(videos/photos)에 저장되고 공개 트레이가 getPublicUrl 로 서빙됐다.
--  archive(하루 뒤 비공개) 시 public→private 객체 이동 상태머신(PR #874)은 유실/starvation 경로가
--  계속 나와 폐기. A안은 미디어를 **처음부터 private 저장 + 공개 서빙도 서버 발급 signed URL** 로 바꿔
--  archive 를 DB status 전환만으로(객체 이동 0) 처리 → 유실 경로 원천 제거.
--
-- A1 범위: 신규 미디어를 이 private 버킷에 저장 + active 스토리 공개 트레이/뷰어를 signed URL 로 서빙.
--  - 기존 videos/photos 버킷은 유지(A3 에서 레거시 데이터 이관 후 서빙 통일).
--  - venue-staging(영상 원본 즉시검증 staging)은 그대로 두고, 검증 통과 원본을 여기로 승격한다.
--
-- 격리 이유: videos/photos 는 venue story 외(움짤콜렉터/DM/아바타 등)도 공유하므로 전체 private 화 금지.
--  venue story 미디어만 이 전용 버킷으로 분리해 privacy 를 격리한다.

-- ── private 미디어 버킷 ─────────────────────────────────────────────
-- public=false: 공개 URL 없음(서빙은 service_role signed URL). 프로젝트 전역 상한과 같은 50MiB.
-- allowed_mime_types: 클라 업로드 1차 방어(사진/포스터 jpeg·png·webp + 승격 영상 mp4/mov/webm/m4v).
--   최종 권위는 서버 검증(ffprobe/매직바이트)이다.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'venue-media',
  'venue-media',
  false,
  52428800, -- 50MiB (Supabase Storage 프로젝트 전역 상한과 일치)
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── storage RLS: authenticated 는 본인 예약 경로 INSERT 만 ──────────
-- 경로 규격: venue-stories/{gameId}/{userId}/{filename} — 3단 폴더의 3번째가 본인 uid.
-- SELECT/UPDATE/DELETE 정책 없음 = authenticated/anon 직접 읽기·삭제 불가(private).
-- 공개 서빙(signed URL 발급)·검증·승격·정리는 전부 service_role(API·워커, RLS bypass)이 수행.
DROP POLICY IF EXISTS "venue_media_insert_own" ON storage.objects;
CREATE POLICY "venue_media_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'venue-media'
    AND (storage.foldername(name))[1] = 'venue-stories'
    AND (storage.foldername(name))[3] = auth.uid()::text
    AND array_length(storage.foldername(name), 1) = 3
    AND name ~ '^venue-stories/[A-Za-z0-9_-]+/[0-9a-fA-F-]{36}/[A-Za-z0-9._-]+$'
  );
