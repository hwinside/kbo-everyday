-- player_game_logs: 선수별 경기 스탯 라인 영속화 (선수 스탯 보강 V1 — 빌드 1)
-- spec: specs/stats/player-stats-v1.md
--
-- 경기 종료(boxscore 확정)마다 출전 선수 1명당 1행 적재. 경기별 탭 / 주간 추이 /
-- (V1.5) 홈원정 스플릿의 단일 원천.
--
-- ⚠️ IP는 numeric 금지 — KBO "5.1"은 5.1이 아니라 5⅓. 정수 아웃(ip_outs)으로 저장하고
--    표시 IP/ERA는 아웃 기준으로 파생한다 (5.1이닝 = 16아웃).
-- ⚠️ team_id/team_code는 ★경기 당시★ 소속을 저장 (이적 시 과거 경기 결과가 흔들리지 않게).

CREATE TABLE IF NOT EXISTS player_game_logs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kbo_id            text NOT NULL,
  player_type       text NOT NULL CHECK (player_type IN ('batter', 'pitcher')),
  game_id           text NOT NULL,
  game_date         date NOT NULL,
  -- 경기 당시 소속/상대 (1-10 canonical teamId + 2글자 코드)
  team_id           integer NOT NULL,
  team_code         text NOT NULL,
  opponent_team_id  integer NOT NULL,
  is_home           boolean NOT NULL,
  result            text NOT NULL CHECK (result IN ('W', 'L', 'D')),
  -- 타자 라인 (player_type='batter')
  ab                integer NOT NULL DEFAULT 0,
  h                 integer NOT NULL DEFAULT 0,
  hr                integer NOT NULL DEFAULT 0,
  rbi               integer NOT NULL DEFAULT 0,
  bb                integer NOT NULL DEFAULT 0,
  so                integer NOT NULL DEFAULT 0,
  -- 투수 라인 (player_type='pitcher'). ip_outs = 총 아웃(정수). er/h_allowed/k/bb_allowed
  ip_outs           integer NOT NULL DEFAULT 0,
  er                integer NOT NULL DEFAULT 0,
  h_allowed         integer NOT NULL DEFAULT 0,
  k                 integer NOT NULL DEFAULT 0,
  bb_allowed        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- 멱등 upsert 키. player_type 포함 — 동일 선수가 타자/투수 두 라인을 가질 수 있음(이도류)
  UNIQUE (kbo_id, player_type, game_id)
);

-- 경기별 탭: 선수 1명의 시즌 전체 경기 (최신순)
CREATE INDEX IF NOT EXISTS idx_pgl_kbo_date
  ON player_game_logs (kbo_id, game_date DESC);
-- 주간 추이/집계: 날짜 범위 스캔
CREATE INDEX IF NOT EXISTS idx_pgl_date
  ON player_game_logs (game_date);
-- 백필 멱등성/디버그: 경기 단위 조회
CREATE INDEX IF NOT EXISTS idx_pgl_game
  ON player_game_logs (game_id);

-- RLS: 공개 읽기 전용. 쓰기는 service_role(백필/cron)만 — RLS 우회.
-- (anon/authenticated용 INSERT/UPDATE/DELETE 정책 없음 = 클라 쓰기 차단)
ALTER TABLE player_game_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read access for game logs" ON player_game_logs;
CREATE POLICY "Public read access for game logs"
  ON player_game_logs FOR SELECT
  USING (true);
