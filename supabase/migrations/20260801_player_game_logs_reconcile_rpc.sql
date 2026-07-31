-- 경기 로그 stale key reconciliation 원자화 RPC.
-- spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §11 적재 순서
--
-- 배경: `player_game_logs` 는 (kbo_id, player_type, game_id) upsert 라서 선수 식별자가
-- 재해석되면(예: 2026-07-04 LG전 `56709|pitcher` → `52731|pitcher`) 구 key 행이 남아
-- canonical hash mismatch 로 영원히 incomplete 된다. 그래서 구 key 삭제가 필요한데,
-- 삭제와 upsert 를 별도 요청으로 하면 중간 실패 시 선수 행이 실제로 사라진다.
--
-- ⚠️ 그 구간은 조용하지 않다 — `/api/player-game-logs`, team-card 주간 집계,
--    venue-attendance 는 ledger 를 보지 않고 `player_game_logs` 를 직접 읽으므로
--    누락된 값을 그대로 노출한다(삼순 P0). venue-stats 만 runtime hash 로 fail-close 한다.
--
-- 그래서 삭제 + upsert 를 **하나의 함수 = 하나의 트랜잭션**으로 묶는다.
-- 함수 본문은 단일 트랜잭션에서 실행되므로 중간 실패 시 삭제도 함께 롤백되고,
-- 외부 소비자는 "구 key 만 있는 상태" 또는 "신 key 만 있는 상태" 중 하나만 관측한다.
--
-- ⚠️ production 선적용 금지 — PR 리뷰·하린아빠 머지 승인 뒤 배포한다.

CREATE OR REPLACE FUNCTION public.reconcile_player_game_logs(
  p_game_id text,
  p_delete_keys jsonb,   -- [{kboId, playerType}] — 호출측 preflight 가 확정한 rekey 구 key
  p_rows jsonb           -- PlayerGameLogRow[] — strict build 가 산출한 기대 행 전체
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer := 0;
  v_upserted integer := 0;
BEGIN
  IF p_game_id IS NULL OR p_game_id = '' THEN
    RAISE EXCEPTION 'p_game_id is required';
  END IF;

  -- 기대 행이 비었는데 삭제만 하는 호출은 데이터 유실이므로 거부한다(fail-closed).
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'p_rows must be a non-empty array';
  END IF;

  -- ── 1) 검증된 rekey 구 key 삭제 ─────────────────────────────────────────
  -- 3키(game_id, kbo_id, player_type) exact 매칭만. 판정은 호출측 preflight 책임이고
  -- 여기서는 지정된 key 외에는 절대 건드리지 않는다.
  IF p_delete_keys IS NOT NULL AND jsonb_typeof(p_delete_keys) = 'array' THEN
    WITH del AS (
      DELETE FROM player_game_logs pgl
      USING jsonb_array_elements(p_delete_keys) AS k(elem)
      WHERE pgl.game_id = p_game_id
        AND pgl.kbo_id = k.elem->>'kboId'
        AND pgl.player_type = k.elem->>'playerType'
      RETURNING 1
    )
    SELECT count(*) INTO v_deleted FROM del;
  END IF;

  -- ── 2) 기대 행 upsert (같은 트랜잭션) ───────────────────────────────────
  WITH ups AS (
    INSERT INTO player_game_logs (
      kbo_id, player_type, game_id, game_date, team_id, team_code,
      opponent_team_id, is_home, result,
      ab, h, hr, rbi, bb, so,
      ip_outs, er, h_allowed, k, bb_allowed
    )
    SELECT
      r->>'kbo_id',
      r->>'player_type',
      r->>'game_id',
      (r->>'game_date')::date,
      (r->>'team_id')::integer,
      r->>'team_code',
      (r->>'opponent_team_id')::integer,
      (r->>'is_home')::boolean,
      r->>'result',
      (r->>'ab')::integer,
      (r->>'h')::integer,
      (r->>'hr')::integer,
      (r->>'rbi')::integer,
      (r->>'bb')::integer,
      (r->>'so')::integer,
      (r->>'ip_outs')::integer,
      (r->>'er')::integer,
      (r->>'h_allowed')::integer,
      (r->>'k')::integer,
      (r->>'bb_allowed')::integer
    FROM jsonb_array_elements(p_rows) AS r
    ON CONFLICT (kbo_id, player_type, game_id) DO UPDATE SET
      game_date = excluded.game_date,
      team_id = excluded.team_id,
      team_code = excluded.team_code,
      opponent_team_id = excluded.opponent_team_id,
      is_home = excluded.is_home,
      result = excluded.result,
      ab = excluded.ab,
      h = excluded.h,
      hr = excluded.hr,
      rbi = excluded.rbi,
      bb = excluded.bb,
      so = excluded.so,
      ip_outs = excluded.ip_outs,
      er = excluded.er,
      h_allowed = excluded.h_allowed,
      k = excluded.k,
      bb_allowed = excluded.bb_allowed,
      updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_upserted FROM ups;

  RETURN jsonb_build_object('deleted', v_deleted, 'upserted', v_upserted);
END;
$$;

-- 적재는 서버 전용 경로다. 클라이언트 role 에는 실행 권한을 주지 않는다.
REVOKE ALL ON FUNCTION public.reconcile_player_game_logs(text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_player_game_logs(text, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.reconcile_player_game_logs(text, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_player_game_logs(text, jsonb, jsonb) TO service_role;
