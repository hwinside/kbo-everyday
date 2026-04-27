-- feedback_attachments 테이블
CREATE TABLE IF NOT EXISTS feedback_attachments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  feedback_id UUID NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  file_type TEXT NOT NULL CHECK (file_type IN ('video', 'image')),
  mime_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  duration_sec REAL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_attachments_feedback
  ON feedback_attachments(feedback_id);

ALTER TABLE feedback_attachments ENABLE ROW LEVEL SECURITY;

-- 본인 attachment만 읽기
CREATE POLICY "Users can read own feedback attachments"
  ON feedback_attachments FOR SELECT
  USING (auth.uid() = user_id);

-- 인증된 유저만 insert
CREATE POLICY "Authenticated users can insert feedback attachments"
  ON feedback_attachments FOR INSERT
  WITH CHECK (auth.role() = 'authenticated' AND auth.uid() = user_id);

-- service_role 전체 접근 (admin API용)
CREATE POLICY "Service role full access on feedback_attachments"
  ON feedback_attachments FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- feedback-videos 버킷 (private, 50MB)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('feedback-videos', 'feedback-videos', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- 인증된 유저만 자기 폴더에 업로드
CREATE POLICY "Users can upload feedback videos"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'feedback-videos'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 본인 파일 삭제
CREATE POLICY "Users can delete own feedback videos"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'feedback-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
