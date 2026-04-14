-- Players Roster Table (SSOT for player data, populated by roster cron)
-- Created: 2026-04-15

CREATE TABLE IF NOT EXISTS players_roster (
  kbo_id text PRIMARY KEY,
  name text NOT NULL,
  team text NOT NULL,
  team_id integer NOT NULL,
  position text NOT NULL DEFAULT '',
  back_no text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_team_id ON players_roster(team_id);
CREATE INDEX IF NOT EXISTS idx_pr_name ON players_roster(name);
CREATE INDEX IF NOT EXISTS idx_pr_updated ON players_roster(updated_at DESC);

-- RLS: anon can SELECT, service_role can INSERT/UPDATE
ALTER TABLE players_roster ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_players_roster"
  ON players_roster FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "service_role_all_players_roster"
  ON players_roster FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
