-- DM 대화방
CREATE TABLE IF NOT EXISTS dm_conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user1_id UUID NOT NULL REFERENCES auth.users(id),
  user2_id UUID NOT NULL REFERENCES auth.users(id),
  last_message TEXT,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user1_id, user2_id)
);

-- DM 메시지
CREATE TABLE IF NOT EXISTS dm_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id),
  content TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_dm_conv_user1 ON dm_conversations(user1_id);
CREATE INDEX IF NOT EXISTS idx_dm_conv_user2 ON dm_conversations(user2_id);
CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_messages_unread ON dm_messages(conversation_id, is_read) WHERE is_read = FALSE;

-- RLS
ALTER TABLE dm_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_messages ENABLE ROW LEVEL SECURITY;

-- 대화방: 참여자만 조회
CREATE POLICY "dm_conv_select" ON dm_conversations FOR SELECT
  USING (auth.uid() = user1_id OR auth.uid() = user2_id);

-- 대화방: 로그인 유저 생성
CREATE POLICY "dm_conv_insert" ON dm_conversations FOR INSERT
  WITH CHECK (auth.uid() = user1_id OR auth.uid() = user2_id);

-- 대화방: 참여자만 업데이트 (last_message)
CREATE POLICY "dm_conv_update" ON dm_conversations FOR UPDATE
  USING (auth.uid() = user1_id OR auth.uid() = user2_id);

-- 메시지: 대화 참여자만 조회
CREATE POLICY "dm_msg_select" ON dm_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM dm_conversations c
      WHERE c.id = dm_messages.conversation_id
      AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  );

-- 메시지: 발신자만 생성
CREATE POLICY "dm_msg_insert" ON dm_messages FOR INSERT
  WITH CHECK (auth.uid() = sender_id);

-- 메시지: 읽음 처리 (수신자만)
CREATE POLICY "dm_msg_update" ON dm_messages FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM dm_conversations c
      WHERE c.id = dm_messages.conversation_id
      AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  );

-- Realtime 활성화
ALTER PUBLICATION supabase_realtime ADD TABLE dm_messages;
