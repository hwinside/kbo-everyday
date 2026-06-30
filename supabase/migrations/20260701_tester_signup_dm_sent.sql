-- 테스터 신청 어드민 화면의 다운로드 쪽지 발송 상태를 영구 저장한다.
-- 기존에는 클라이언트 state에만 남아 페이지 재진입 시 "쪽지 보내기"로 되돌아갔다.

ALTER TABLE tester_signups
  ADD COLUMN IF NOT EXISTS dm_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dm_conversation_id UUID REFERENCES dm_conversations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tester_signups_dm_sent
  ON tester_signups(dm_sent_at DESC)
  WHERE dm_sent_at IS NOT NULL;

-- 이미 발송된 Play 스토어 안내 쪽지가 있으면 기존 신청 row에도 발송 상태를 채운다.
WITH sent AS (
  SELECT DISTINCT ON (ts.id)
    ts.id AS signup_id,
    c.id AS conversation_id,
    m.created_at AS sent_at
  FROM tester_signups ts
  JOIN dm_conversations c
    ON c.user1_id = ts.user_id OR c.user2_id = ts.user_id
  JOIN dm_messages m
    ON m.conversation_id = c.id
  WHERE m.content ILIKE '%play.google.com/store/apps/details?id=fan.keubo.app%'
  ORDER BY ts.id, m.created_at DESC
)
UPDATE tester_signups ts
SET
  dm_sent_at = sent.sent_at,
  dm_conversation_id = sent.conversation_id
FROM sent
WHERE ts.id = sent.signup_id
  AND ts.dm_sent_at IS NULL;
