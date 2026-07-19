-- 팀별 1군 선수 등록/말소(로스터 변동) 내역 (2026-07-18 CS 유저 건의).
-- cron이 KBO 공식 등록명단을 구단별 스냅샷으로 적재 → 직전 스냅샷 대비 diff로 등록/말소 이벤트 생성.
-- ⚠️ 이 마이그레이션은 PR 머지 전 prod에 선적용해야 한다(cron/API가 이 테이블에 의존).

-- ① 스냅샷: 구단별 당일 1군 등록명단 전체 — diff 계산 입력(서버 전용 데이터).
--    captured_at: 이 스냅샷을 만든 KBO 수집 run의 수집 완료 시각(2026-07-18 삼순 P0/P1 3차).
--    stale run 역순 커밋 차단용 워터마크 — RPC가 저장된 captured_at보다 오래된 쓰기를 거부한다.
CREATE TABLE IF NOT EXISTS roster_snapshots (
  snapshot_date DATE NOT NULL,
  team_id INT NOT NULL,
  kbo_player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  back_no TEXT,
  position TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, team_id, kbo_player_id)
);
-- 기존(이전 PR 반복분)에 captured_at 없이 만들어졌을 수 있어 방어적으로 추가.
ALTER TABLE roster_snapshots ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ NOT NULL DEFAULT now();
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
  -- published 등록 링크 불변식(2026-07-18 삼순 P0 3차): 승격 시 검증한 canonical kboId를 함께 저장한다.
  -- API는 이 저장값으로 published 등록 href를 항상 non-null로 생성한다(조회 시점 재resolve 의존 제거).
  -- 등록 pending·말소는 canonical_id를 쓰지 않는다(NULL).
  canonical_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, kbo_player_id, move_type, move_date)
);
-- 기존(이전 PR 반복분)에 canonical_id 없이 만들어졌을 수 있어 방어적으로 추가.
ALTER TABLE roster_moves ADD COLUMN IF NOT EXISTS canonical_id TEXT;
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
  p_entries JSONB,      -- [{ "kboId", "name", "backNo", "position" }]
  p_moves JSONB,        -- [{ "kboPlayerId", "playerName", "moveType", "status" }]
  p_captured_at TIMESTAMPTZ  -- 이 run의 KBO 수집 완료 시각(stale run 역순 커밋 차단 워터마크).
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keys TEXT[];
  v_stored_captured_at TIMESTAMPTZ;
BEGIN
  -- 동시 2회 실행 경합 차단: 같은 팀에 대한 교체는 직렬화(트랜잭션 종료 시 자동 해제).
  PERFORM pg_advisory_xact_lock(hashtext('roster_day_' || p_team_id::text));

  -- ★ stale run 역순 커밋 차단(2026-07-18 삼순 P0/P1 3차):
  --   수집·전일조회·diff는 lock 밖에서 수행되므로, 먼저 수집한 run A가 lock을 늦게 잡으면
  --   나중에 수집한 최신 run B를 덮어쓸 수 있다. lock 획득 후 저장된 스냅샷의 capture 시각과
  --   비교해, 이번 요청이 기존보다 오래되거나 같으면(즉 이미 더 최신 run이 썼으면) no-op으로 거부한다.
  --   → 항상 최신 capture가 이긴다. (스냅샷은 prod에서 항상 비어있지 않음 — validateRosterCollection 최소인원 보장.)
  SELECT MAX(captured_at) INTO v_stored_captured_at
    FROM roster_snapshots
   WHERE team_id = p_team_id AND snapshot_date = p_snapshot_date;
  IF v_stored_captured_at IS NOT NULL AND p_captured_at <= v_stored_captured_at THEN
    RETURN jsonb_build_object(
      'teamId', p_team_id,
      'snapshotDate', p_snapshot_date,
      'applied', false,
      'reason', 'stale_capture',
      'storedCapturedAt', v_stored_captured_at,
      'capturedAt', p_captured_at
    );
  END IF;

  -- 스냅샷 원자 교체(delete+insert) — 1 트랜잭션이라 외부 리더에 빈 창이 보이지 않는다.
  DELETE FROM roster_snapshots
   WHERE team_id = p_team_id AND snapshot_date = p_snapshot_date;
  INSERT INTO roster_snapshots (snapshot_date, team_id, kbo_player_id, player_name, back_no, position, captured_at)
  SELECT p_snapshot_date, p_team_id,
         e->>'kboId', e->>'name', NULLIF(e->>'backNo', ''), NULLIF(e->>'position', ''), p_captured_at
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
    'applied', true,
    'entries', jsonb_array_length(p_entries),
    'moves', jsonb_array_length(p_moves)
  );
END;
$$;

-- RPC는 service_role(cron)만 실행 — anon/authenticated 실행 차단(2026-07-18 삼순 P0 3차).
-- ⚠️ REVOKE ... FROM PUBLIC 만으로는 부족: 이 저장소의 Supabase는 ALTER DEFAULT PRIVILEGES로 anon/
--    authenticated/service_role에 EXECUTE를 자동 부여하므로 명시적으로 anon/authenticated를 revoke해야
--    한다(사례: 20260527_gamechat_message_delete_grants_hotfix.sql). 구 시그니처(4-arg)도 정리.
DROP FUNCTION IF EXISTS replace_team_roster_day(INT, DATE, JSONB, JSONB);
REVOKE ALL     ON FUNCTION replace_team_roster_day(INT, DATE, JSONB, JSONB, TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION replace_team_roster_day(INT, DATE, JSONB, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION replace_team_roster_day(INT, DATE, JSONB, JSONB, TIMESTAMPTZ) TO service_role;

-- ============================================================
-- 검증 쿼리(배포 후 — anon EXECUTE 0건, service_role만 EXECUTE):
--   SELECT grantee, privilege_type
--     FROM information_schema.routine_privileges
--    WHERE routine_name = 'replace_team_roster_day'
--    ORDER BY grantee;
--   -- 기대: service_role/EXECUTE + postgres/EXECUTE(superuser 자동) 만. anon/authenticated 없어야 함.
-- ============================================================
