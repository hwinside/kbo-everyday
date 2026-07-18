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
  -- 공개 게이트(2026-07-18 삼순 P0 반영): 준비 → 공개 순서 보장.
  -- 등록(register)은 'pending'으로 생성 → cron 승격 단계가 readiness(로스터 SSOT+프로필+히어로+상세페이지)
  -- 전체 통과를 확인한 뒤에만 'published'. 말소(deregister)는 준비 개념이 없어 즉시 'published'.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, kbo_player_id, move_type, move_date)
);
CREATE INDEX IF NOT EXISTS idx_roster_moves_team_date
  ON roster_moves (team_id, move_date DESC);

-- 스냅샷은 diff 계산용 내부 데이터 — RLS on + 정책 0개 = 일반 클라 접근 거부(service_role만).
ALTER TABLE roster_snapshots ENABLE ROW LEVEL SECURITY;

-- 변동 이벤트는 공개 정보 — 단 published만 노출(pending 등록은 준비 미완료라 RLS 레벨에서도 차단).
-- anon/authenticated 읽기 허용, 쓰기는 service_role(RLS 우회)만.
ALTER TABLE roster_moves ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read access for roster moves" ON roster_moves;
CREATE POLICY "Public read access for roster moves"
  ON roster_moves FOR SELECT
  USING (status = 'published');

-- ③ 팀/일자 스냅샷+무브 원자 교체 RPC (2026-07-18 삼순 P0/P1 2차 반영).
--    기존 cron은 select/upsert/delete/update 여러 PostgREST 호출로 나눠 부분 상태·동시 실행
--    경합·오류 무시(마이그레이션 미적용에도 ok:true)가 가능했다. 이를 단일 함수 1트랜잭션으로 묶는다:
--    - pg_advisory_xact_lock(team_id): 동시 2회 실행을 팀 단위로 직렬화(경합 차단).
--    - 함수 본문 = 1 트랜잭션 → 스냅샷 delete+insert, 무브 upsert+stale delete가 all-or-nothing.
--      (부분 상태 제거: 커밋 전 실패는 전량 롤백 → 기존 상태 불변.)
--    - 무브 upsert는 ON CONFLICT DO NOTHING(published→pending 강등 금지 = 상태 보존).
--    cron은 이 함수 호출 결과 error를 확인해 실패 시 5xx fail-closed 한다. 함수 미존재
--    (마이그레이션 미적용)면 RPC가 error를 반환 → cron이 절대 ok:true를 못 낸다.
CREATE OR REPLACE FUNCTION replace_team_roster_day(
  p_team_id INT,
  p_snapshot_date DATE,
  p_entries JSONB,   -- [{ "kboId", "name", "backNo", "position" }]
  p_moves JSONB      -- [{ "kboPlayerId", "playerName", "moveType", "status" }]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keys TEXT[];
BEGIN
  -- 동시 2회 실행 경합 차단: 같은 팀에 대한 교체는 직렬화(트랜잭션 종료 시 자동 해제).
  PERFORM pg_advisory_xact_lock(hashtext('roster_day_' || p_team_id::text));

  -- 스냅샷 원자 교체(delete+insert) — 1 트랜잭션이라 외부 리더에 빈 창이 보이지 않는다.
  DELETE FROM roster_snapshots
   WHERE team_id = p_team_id AND snapshot_date = p_snapshot_date;
  INSERT INTO roster_snapshots (snapshot_date, team_id, kbo_player_id, player_name, back_no, position)
  SELECT p_snapshot_date, p_team_id,
         e->>'kboId', e->>'name', NULLIF(e->>'backNo', ''), NULLIF(e->>'position', '')
    FROM jsonb_array_elements(p_entries) AS e;

  -- 무브 교체: 계획 집합 upsert(기존 status 보존) → 계획 밖 오늘자 row 삭제.
  INSERT INTO roster_moves (team_id, kbo_player_id, player_name, move_type, move_date, status)
  SELECT p_team_id, m->>'kboPlayerId', m->>'playerName', m->>'moveType', p_snapshot_date, m->>'status'
    FROM jsonb_array_elements(p_moves) AS m
  ON CONFLICT (team_id, kbo_player_id, move_type, move_date) DO NOTHING;

  SELECT COALESCE(array_agg((m->>'kboPlayerId') || '|' || (m->>'moveType')), ARRAY[]::text[])
    INTO v_keys
    FROM jsonb_array_elements(p_moves) AS m;

  DELETE FROM roster_moves
   WHERE team_id = p_team_id
     AND move_date = p_snapshot_date
     AND (kbo_player_id || '|' || move_type) <> ALL (v_keys);

  RETURN jsonb_build_object(
    'teamId', p_team_id,
    'snapshotDate', p_snapshot_date,
    'entries', jsonb_array_length(p_entries),
    'moves', jsonb_array_length(p_moves)
  );
END;
$$;

-- RPC는 service_role(cron)만 실행 — anon/authenticated 실행 차단.
REVOKE ALL ON FUNCTION replace_team_roster_day(INT, DATE, JSONB, JSONB) FROM PUBLIC;
