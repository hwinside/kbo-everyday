-- 수비 실책(error) 선수별 집계 컬럼 — 하린아빠 2026-08-02 `발암경기 인내형` 태그 트랙.
--
-- 설계 결정: `errors` 는 **canonical payload hash 에 넣지 않는다.**
--   `CANONICAL_ROW_FIELDS` 20필드는 `player_game_log_ingestions` 의 expected_payload_hash
--   계산 기준이고, 운영에 이미 complete 원장 468건이 쌓여 있다. 필드를 추가하면 그 468건이
--   전부 payload_hash_mismatch 로 뒤집혀 직관 통계가 전 유저 fail-close 된다(= P0 장애).
--   그래서 실책은 **nullable enrichment 컬럼**으로 두고, 완전성은 자체 신호로 판정한다.
--
-- NULL 의 의미: "이 경기의 실책을 아직 모른다"(0 아님).
--   실책 0 경기는 실제로 0 을 적재한다. 태그는 NULL 경기를 분모에서 제외한다.

ALTER TABLE public.player_game_logs
  ADD COLUMN IF NOT EXISTS errors smallint;

COMMENT ON COLUMN public.player_game_logs.errors IS
  '수비 실책 수. NULL = 미상(0 아님). 선수별 파싱 합계가 공식 팀 실책 합계(rheb.e)와 팀 단위로 exact 일치할 때만 적재된다. canonical payload hash 미포함(기존 원장 보존).';

-- 음수 방지. NULL 은 허용(미상).
ALTER TABLE public.player_game_logs
  DROP CONSTRAINT IF EXISTS player_game_logs_errors_nonneg;
ALTER TABLE public.player_game_logs
  ADD CONSTRAINT player_game_logs_errors_nonneg
  CHECK (errors IS NULL OR errors >= 0);

-- 경기 단위 실책 적재 상태. 태그가 "모르는 경기"를 0 으로 오독하지 않도록
-- 원장에 별도 신호를 둔다. NULL = 아직 시도 안 함.
ALTER TABLE public.player_game_log_ingestions
  ADD COLUMN IF NOT EXISTS errors_status text;

ALTER TABLE public.player_game_log_ingestions
  DROP CONSTRAINT IF EXISTS player_game_log_ingestions_errors_status_check;
ALTER TABLE public.player_game_log_ingestions
  ADD CONSTRAINT player_game_log_ingestions_errors_status_check
  CHECK (errors_status IS NULL OR errors_status IN ('complete', 'unavailable'));

COMMENT ON COLUMN public.player_game_log_ingestions.errors_status IS
  'complete = 선수별 실책이 공식 팀 합계와 대조 검증되어 적재됨. unavailable = 소스 결측/불일치로 미상. NULL = 미시도(백필 전).';

-- ── 실책 적재 RPC ────────────────────────────────────────────────────────
-- `reconcile_player_game_logs` 를 건드리지 않는 이유: 그 함수는 canonical hash 계약과
-- 1:1로 묶여 있고 운영 원장 468건이 그 계약 위에 서 있다. 실책은 hash 바깥의
-- enrichment 라서 **별도 함수**로 분리해, 실책 적재가 실패해도 본 적재 계약이
-- 흔들리지 않게 한다(관심사 분리 + 롤백 범위 축소).
--
-- 계약: 호출측이 팀 합계 대조를 통과한 경우에만 부른다. 여기서는 지정된
-- (game_id, kbo_id, player_type) 행만 갱신하고, 같은 경기의 나머지 행은
-- 명시적으로 0 으로 채운다 — "실책을 안 한 선수"와 "모르는 경기"를 구분하기 위해서다.
CREATE OR REPLACE FUNCTION public.apply_player_game_log_errors(
  p_game_id text,
  p_errors jsonb   -- [{kboId, playerType, errors}] — 검증 통과한 실책 선수만
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_zeroed integer := 0;
  v_set integer := 0;
BEGIN
  IF p_game_id IS NULL OR p_game_id = '' THEN
    RAISE EXCEPTION 'p_game_id is required';
  END IF;
  IF p_errors IS NULL OR jsonb_typeof(p_errors) <> 'array' THEN
    RAISE EXCEPTION 'p_errors must be an array';
  END IF;

  -- 1) 이 경기 전 행을 0 으로 — 검증을 통과했으므로 "실책 없음"이 확정 사실이다.
  UPDATE player_game_logs SET errors = 0, updated_at = now()
  WHERE game_id = p_game_id AND errors IS DISTINCT FROM 0;
  GET DIAGNOSTICS v_zeroed = ROW_COUNT;

  -- 2) 실책 선수만 실제 값으로.
  WITH upd AS (
    UPDATE player_game_logs pgl
    SET errors = (e.elem->>'errors')::smallint, updated_at = now()
    FROM jsonb_array_elements(p_errors) AS e(elem)
    WHERE pgl.game_id = p_game_id
      AND pgl.kbo_id = e.elem->>'kboId'
      AND pgl.player_type = e.elem->>'playerType'
    RETURNING 1
  )
  SELECT count(*) INTO v_set FROM upd;

  -- 검증 통과분이 실제 행에 전부 붙지 않았으면 데이터 불일치다 — 롤백한다.
  IF v_set <> jsonb_array_length(p_errors) THEN
    RAISE EXCEPTION 'error rows not fully applied for %: expected %, applied %',
      p_game_id, jsonb_array_length(p_errors), v_set;
  END IF;

  RETURN jsonb_build_object('zeroed', v_zeroed, 'set', v_set);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_player_game_log_errors(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_player_game_log_errors(text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.apply_player_game_log_errors(text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_player_game_log_errors(text, jsonb) TO service_role;
