-- Naver/KBO 원본 선수 ID를 durable conflict key로 사용한다.
-- 기존 (name, team) PK는 같은 팀의 동명이인을 표현하지 못한다.

ALTER TABLE player_stats_batter ADD COLUMN IF NOT EXISTS player_key text;
ALTER TABLE player_stats_pitcher ADD COLUMN IF NOT EXISTS player_key text;

UPDATE player_stats_batter
SET player_key = COALESCE(NULLIF(kbo_id, ''), 'legacy:' || team || ':' || name)
WHERE player_key IS NULL;

UPDATE player_stats_pitcher
SET player_key = COALESCE(NULLIF(kbo_id, ''), 'legacy:' || team || ':' || name)
WHERE player_key IS NULL;

-- 같은 kbo_id가 팀 이동 등으로 여러 행에 남아 있으면 최신 행만 보존한다.
WITH ranked AS (
  SELECT ctid, row_number() OVER (
    PARTITION BY player_key
    ORDER BY updated_at DESC NULLS LAST, team, name
  ) AS rn
  FROM player_stats_batter
)
DELETE FROM player_stats_batter p
USING ranked r
WHERE p.ctid = r.ctid AND r.rn > 1;

WITH ranked AS (
  SELECT ctid, row_number() OVER (
    PARTITION BY player_key
    ORDER BY updated_at DESC NULLS LAST, team, name
  ) AS rn
  FROM player_stats_pitcher
)
DELETE FROM player_stats_pitcher p
USING ranked r
WHERE p.ctid = r.ctid AND r.rn > 1;

ALTER TABLE player_stats_batter ALTER COLUMN player_key SET NOT NULL;
ALTER TABLE player_stats_pitcher ALTER COLUMN player_key SET NOT NULL;

ALTER TABLE player_stats_batter DROP CONSTRAINT IF EXISTS player_stats_batter_pkey;
ALTER TABLE player_stats_pitcher DROP CONSTRAINT IF EXISTS player_stats_pitcher_pkey;
ALTER TABLE player_stats_batter ADD CONSTRAINT player_stats_batter_pkey PRIMARY KEY (player_key);
ALTER TABLE player_stats_pitcher ADD CONSTRAINT player_stats_pitcher_pkey PRIMARY KEY (player_key);

CREATE INDEX IF NOT EXISTS idx_psb_name_team ON player_stats_batter(name, team);
CREATE INDEX IF NOT EXISTS idx_psp_name_team ON player_stats_pitcher(name, team);
