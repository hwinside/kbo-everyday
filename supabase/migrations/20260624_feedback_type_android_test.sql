-- feedback.type 허용값에 'android_test'(안드로이드앱 테스트) 추가
-- 기존: bug | data | feature | content | other
ALTER TABLE feedback DROP CONSTRAINT IF EXISTS feedback_type_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_type_check
  CHECK (type = ANY (ARRAY['bug', 'data', 'feature', 'content', 'other', 'android_test']));
