-- 직관 라이브 사진/영상 포스터 업로드 경로 허용.
-- 기존 photos 정책은 {userId}/... 구조만 허용해 venue-stories/{gameId}/{userId}/{file}
-- 경로를 전부 RLS로 거부했다. 신규 경로만 exact 규격으로 추가 허용한다.

DROP POLICY IF EXISTS venue_photos_insert_own ON storage.objects;
CREATE POLICY venue_photos_insert_own
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'photos'
  AND (storage.foldername(name))[1] = 'venue-stories'
  AND (storage.foldername(name))[3] = auth.uid()::text
  AND array_length(storage.foldername(name), 1) = 3
  AND name ~ '^venue-stories/[A-Za-z0-9_-]+/[0-9a-fA-F-]{36}/[A-Za-z0-9._-]+$'
);
