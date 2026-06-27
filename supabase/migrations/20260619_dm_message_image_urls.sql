-- 쪽지(dm_messages)에 이미지 첨부 지원: 공개 Storage URL 배열
ALTER TABLE dm_messages
  ADD COLUMN IF NOT EXISTS image_urls TEXT[] NOT NULL DEFAULT '{}';
