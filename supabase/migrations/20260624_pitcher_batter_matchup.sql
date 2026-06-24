-- 투타 통산 맞대결 V2 — 네이버 relay `pitcherVsBatterCareerStats`(전 시즌 누적 통산) 캡처 저장.
-- (투수 kboId, 타자 kboId) 페어별 *최신 스냅샷* upsert. 값이 누적이라 한 번만 잡혀도 완전한 통산값.
-- forward-only (과거 백필 없음). 캡처 = game-events-warmup cron(매분 라이브게임).
CREATE TABLE IF NOT EXISTS pitcher_batter_matchup (
  pitcher_kbo_id TEXT NOT NULL,
  batter_kbo_id  TEXT NOT NULL,
  pitcher_name   TEXT NOT NULL,
  batter_name    TEXT NOT NULL,
  ab    INTEGER NOT NULL,
  hits  INTEGER NOT NULL,
  hr    INTEGER NOT NULL,
  avg   NUMERIC NOT NULL,
  raw_line     TEXT NOT NULL,
  last_game_id TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pitcher_kbo_id, batter_kbo_id)
);

-- 선수 페이지 조회용(타자별 / 투수별 리스트)
CREATE INDEX IF NOT EXISTS idx_pbm_batter  ON pitcher_batter_matchup (batter_kbo_id);
CREATE INDEX IF NOT EXISTS idx_pbm_pitcher ON pitcher_batter_matchup (pitcher_kbo_id);

-- RLS: 공개 읽기 전용 통계. 쓰기는 service_role(RLS bypass)만 — 별도 write 정책 없음 = anon/authenticated INSERT/UPDATE 차단.
ALTER TABLE pitcher_batter_matchup ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pbm public read" ON pitcher_batter_matchup;
CREATE POLICY "pbm public read" ON pitcher_batter_matchup FOR SELECT USING (true);
