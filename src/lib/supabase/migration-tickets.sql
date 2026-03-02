-- 티켓 양도 게시판 테이블
-- Run this in Supabase SQL Editor

CREATE TABLE ticket_transfers (
  id BIGSERIAL PRIMARY KEY,
  author_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  team_id INT NOT NULL,
  venue_id TEXT NOT NULL,
  game_date DATE NOT NULL,
  opponent_team_id INT,
  seat_area TEXT NOT NULL,
  seat_detail TEXT,
  quantity INT NOT NULL DEFAULT 1,
  price INT NOT NULL,
  original_price INT,
  status TEXT DEFAULT 'open',
  contact_method TEXT NOT NULL,
  contact_info TEXT,
  description TEXT,
  image_urls JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);

ALTER TABLE ticket_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read" ON ticket_transfers FOR SELECT USING (true);
CREATE POLICY "Auth users create" ON ticket_transfers FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Authors update own" ON ticket_transfers FOR UPDATE USING (auth.uid() = author_id);
CREATE POLICY "Authors delete own" ON ticket_transfers FOR DELETE USING (auth.uid() = author_id);

CREATE INDEX idx_tickets_team ON ticket_transfers(team_id, game_date DESC);
CREATE INDEX idx_tickets_venue ON ticket_transfers(venue_id, game_date DESC);
CREATE INDEX idx_tickets_status ON ticket_transfers(status, game_date DESC);
