-- 푸시 알림 v1 — S1 토대: 네이티브 디바이스 FCM 토큰 저장
-- iOS/Android 모두 FCM token (A안: FCM 단일 게이트웨이). 웹은 기존 push_subscriptions 유지.

CREATE TABLE IF NOT EXISTS device_push_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  fcm_token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_seen TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE device_push_tokens ENABLE ROW LEVEL SECURITY;

-- 본인 토큰만 등록/upsert (auth.uid() 일치 필수 — 익명 등록 불가)
CREATE POLICY "Users insert own device token" ON device_push_tokens
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own device token" ON device_push_tokens
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users read own device token" ON device_push_tokens
  FOR SELECT USING (auth.uid() = user_id);
-- 만료/무효 토큰 정리는 service_role(서버)에서 수행
CREATE POLICY "Users delete own device token" ON device_push_tokens
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_device_push_user ON device_push_tokens(user_id);
