-- 푸시 알림 v1 — 이닝 득점 요약 발송 상태.
-- warmup cron이 득점 이벤트를 half-inning 단위로 누적하고,
-- 해당 half-inning이 끝난 뒤 my_team_score_inning_summary 알림을 1회 발송한다.

CREATE TABLE IF NOT EXISTS inning_score_summary_state (
  game_id TEXT NOT NULL,
  inning INTEGER NOT NULL,
  is_top BOOLEAN NOT NULL,
  team_id INTEGER NOT NULL,
  team_name TEXT NOT NULL,
  away_name TEXT NOT NULL,
  home_name TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0 CHECK (runs >= 0),
  away_score INTEGER NOT NULL DEFAULT 0,
  home_score INTEGER NOT NULL DEFAULT 0,
  sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, inning, is_top)
);

CREATE INDEX IF NOT EXISTS idx_inning_score_summary_state_unsent
  ON inning_score_summary_state (sent, game_id);

ALTER TABLE inning_score_summary_state ENABLE ROW LEVEL SECURITY;
-- service_role(cron)만 사용 — 클라이언트 정책 없음 (default deny)
