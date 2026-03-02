CREATE TABLE push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  endpoint TEXT UNIQUE NOT NULL,
  subscription JSONB NOT NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone inserts" ON push_subscriptions FOR INSERT WITH CHECK (true);
CREATE POLICY "Users read own" ON push_subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Delete expired" ON push_subscriptions FOR DELETE USING (true);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
