-- Naver/KBO 원본 선수 ID를 durable conflict key로 사용한다.
-- 기존 (name, team) PK는 같은 팀의 동명이인을 표현하지 못한다.

ALTER TABLE player_stats_batter ADD COLUMN IF NOT EXISTS player_key text;
ALTER TABLE player_stats_pitcher ADD COLUMN IF NOT EXISTS player_key text;

-- Production에서 kbo_id가 비어 있던 두 선수는 이름 기반 legacy key로 남기면
-- 이후 실 ID upsert와 별도 행이 되어 유령 레코드가 된다. 정본 로스터 ID를 먼저
-- 복구한 뒤 일반 backfill/dedupe를 수행해 같은 선수는 한 행으로 수렴시킨다.
WITH known(name, team, canonical_id) AS (
  VALUES
    ('김윤식', 'LG', '50157'),
    ('미야지', '삼성', 'AQ003'),
    ('미야지 유라', '삼성', 'AQ003')
)
UPDATE player_stats_batter p
SET kbo_id = known.canonical_id, player_key = known.canonical_id
FROM known
WHERE p.name = known.name
  AND p.team = known.team
  AND NULLIF(p.kbo_id, '') IS NULL;

WITH known(name, team, canonical_id) AS (
  VALUES
    ('김윤식', 'LG', '50157'),
    ('미야지', '삼성', 'AQ003'),
    ('미야지 유라', '삼성', 'AQ003')
)
UPDATE player_stats_pitcher p
SET kbo_id = known.canonical_id, player_key = known.canonical_id
FROM known
WHERE p.name = known.name
  AND p.team = known.team
  AND NULLIF(p.kbo_id, '') IS NULL;

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
