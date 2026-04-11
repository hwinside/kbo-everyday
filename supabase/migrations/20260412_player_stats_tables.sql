-- Player Stats Tables for Cron Updates
-- Created: 2026-04-12

-- Batter Stats
CREATE TABLE IF NOT EXISTS player_stats_batter (
  name text NOT NULL,
  team text NOT NULL,
  kbo_id text,
  rank integer,
  avg text,
  games integer DEFAULT 0,
  pa integer DEFAULT 0,
  ab integer DEFAULT 0,
  runs integer DEFAULT 0,
  hits integer DEFAULT 0,
  doubles integer DEFAULT 0,
  triples integer DEFAULT 0,
  hr integer DEFAULT 0,
  tb integer DEFAULT 0,
  rbi integer DEFAULT 0,
  sac integer DEFAULT 0,
  sf integer DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (name, team)
);

CREATE INDEX IF NOT EXISTS idx_psb_rank ON player_stats_batter(rank);
CREATE INDEX IF NOT EXISTS idx_psb_kbo_id ON player_stats_batter(kbo_id);
CREATE INDEX IF NOT EXISTS idx_psb_updated ON player_stats_batter(updated_at DESC);

-- Pitcher Stats
CREATE TABLE IF NOT EXISTS player_stats_pitcher (
  name text NOT NULL,
  team text NOT NULL,
  kbo_id text,
  rank integer,
  era text,
  games integer DEFAULT 0,
  wins integer DEFAULT 0,
  losses integer DEFAULT 0,
  saves integer DEFAULT 0,
  holds integer DEFAULT 0,
  wpct text,
  ip text,
  h integer DEFAULT 0,
  hr integer DEFAULT 0,
  bb integer DEFAULT 0,
  hbp integer DEFAULT 0,
  so integer DEFAULT 0,
  r integer DEFAULT 0,
  er integer DEFAULT 0,
  whip text,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (name, team)
);

CREATE INDEX IF NOT EXISTS idx_psp_rank ON player_stats_pitcher(rank);
CREATE INDEX IF NOT EXISTS idx_psp_kbo_id ON player_stats_pitcher(kbo_id);
CREATE INDEX IF NOT EXISTS idx_psp_updated ON player_stats_pitcher(updated_at DESC);

-- Enable RLS (optional, set policies as needed)
ALTER TABLE player_stats_batter ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_stats_pitcher ENABLE ROW LEVEL SECURITY;

-- Public read access (no auth required)
CREATE POLICY "Public read access for batter stats"
  ON player_stats_batter FOR SELECT
  USING (true);

CREATE POLICY "Public read access for pitcher stats"
  ON player_stats_pitcher FOR SELECT
  USING (true);

-- Service role write access only (cron jobs use service role key)
-- No INSERT/UPDATE/DELETE policies needed — service role bypasses RLS
