-- 팀별 1군 선수 등록/말소(로스터 변동) 내역 (2026-07-18 CS 유저 건의).
-- cron이 KBO 공식 등록명단을 구단별 스냅샷으로 적재 → 직전 스냅샷 대비 diff로 등록/말소 이벤트 생성.
-- ⚠️ 이 마이그레이션은 PR 머지 전 prod에 선적용해야 한다(cron/API가 이 테이블에 의존).

-- ① 스냅샷: 구단별 당일 1군 등록명단 전체 — diff 계산 입력(서버 전용 데이터).
CREATE TABLE IF NOT EXISTS roster_snapshots (
  snapshot_date DATE NOT NULL,
  team_id INT NOT NULL,
  kbo_player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  back_no TEXT,
  position TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, team_id, kbo_player_id)
);
CREATE INDEX IF NOT EXISTS idx_roster_snapshots_team_date
  ON roster_snapshots (team_id, snapshot_date DESC);

-- ② 로스터 변동 이벤트 — 직전 스냅샷 대비 diff.
--    unique(team_id,kbo_player_id,move_type,move_date)로 cron 재실행/중복 틱에도 멱등.
CREATE TABLE IF NOT EXISTS roster_moves (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id INT NOT NULL,
  kbo_player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  move_type TEXT NOT NULL CHECK (move_type IN ('register', 'deregister')),
  move_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, kbo_player_id, move_type, move_date)
);
CREATE INDEX IF NOT EXISTS idx_roster_moves_team_date
  ON roster_moves (team_id, move_date DESC);

-- 스냅샷은 diff 계산용 내부 데이터 — RLS on + 정책 0개 = 일반 클라 접근 거부(service_role만).
ALTER TABLE roster_snapshots ENABLE ROW LEVEL SECURITY;

-- 변동 이벤트는 공개 정보 — anon/authenticated 읽기 허용, 쓰기는 service_role(RLS 우회)만.
ALTER TABLE roster_moves ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read access for roster moves" ON roster_moves;
CREATE POLICY "Public read access for roster moves"
  ON roster_moves FOR SELECT
  USING (true);
