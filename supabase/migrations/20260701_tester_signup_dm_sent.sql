-- tester_signups.dm_sent_at: 운영팀이 다운로드 안내 쪽지를 발송한 시각.
-- 어드민 테스터 신청 목록에서 '발송됨' 표시가 화면 임시상태라 페이지 재진입 시 초기화되던 문제를
-- DB에 영구 기록해 해결한다. NULL = 미발송. service_role(서버 API)만 갱신.

ALTER TABLE tester_signups
  ADD COLUMN IF NOT EXISTS dm_sent_at TIMESTAMPTZ;

-- 기존 발송분 backfill: 운영팀(OPERATOR_USER_ID)이 보낸 Play 스토어 링크 포함 쪽지를
-- tester_signups.dm_sent_at에 채운다. 최초 발송 시각 기준.
UPDATE tester_signups ts
SET dm_sent_at = (
  SELECT MIN(m.created_at)
  FROM dm_messages m
  JOIN dm_conversations c ON c.id = m.conversation_id
  WHERE m.content LIKE '%play.google.com%'
    AND m.sender_id = '7b58d68e-e212-40aa-a96d-5018cb82cc81'  -- OPERATOR_USER_ID
    AND (c.user1_id = ts.user_id OR c.user2_id = ts.user_id)
)
WHERE ts.dm_sent_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM dm_messages m
    JOIN dm_conversations c ON c.id = m.conversation_id
    WHERE m.content LIKE '%play.google.com%'
      AND m.sender_id = '7b58d68e-e212-40aa-a96d-5018cb82cc81'
      AND (c.user1_id = ts.user_id OR c.user2_id = ts.user_id)
  );
