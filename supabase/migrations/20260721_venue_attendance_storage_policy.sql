-- 직관 스토리 사진 업로드 경로용 authenticated INSERT 정책.
-- 기존 photos 정책은 {userId}/... 만 허용하지만 직관 스토리는
-- venue-stories/{gameId}/{userId}/{filename} 구조를 사용한다.

DROP POLICY IF EXISTS "venue_photos_insert_own" ON storage.objects;
CREATE POLICY "venue_photos_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'photos'
    AND (storage.foldername(name))[1] = 'venue-stories'
    AND (storage.foldername(name))[3] = auth.uid()::text
    AND array_length(storage.foldername(name), 1) = 3
    AND name ~ '^venue-stories/[A-Za-z0-9_-]+/[0-9a-fA-F-]{36}/[A-Za-z0-9._-]+$'
  );
