-- 사진게시판 동영상(mp4) 업로드 v1 마이그레이션
-- 수동 실행: Supabase Dashboard > SQL Editor

-- 1. videos 버킷 생성
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('videos', 'videos', true, 20971520)
ON CONFLICT (id) DO NOTHING;

-- 2. videos 버킷 RLS
CREATE POLICY "Anyone can view videos" ON storage.objects
  FOR SELECT USING (bucket_id = 'videos');

CREATE POLICY "Authenticated users can upload videos" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'videos' AND auth.role() = 'authenticated');

CREATE POLICY "Users can delete own videos" ON storage.objects
  FOR DELETE USING (bucket_id = 'videos' AND auth.uid()::text = (storage.foldername(name))[1]);

-- 3. posts 테이블에 video_urls 추가
ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_urls text[] DEFAULT '{}';
