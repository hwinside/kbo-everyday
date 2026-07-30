-- 직관 다이어리 통계 S1a — player_game_logs 적재 완료 증거 ledger.
-- spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §11 (durable ledger) / §12 (canonical payload hash)
--
-- 목적: B/C(팀·최애 부스트) 집계의 complete 판정은 행 집계 heuristic을 금지하고
-- 이 durable ledger만 사용한다(§9 coverage). 경기별 적재 파이프라인이
--   boxscore 파싱 → 필수필드 fail-closed 검증 → resolve 1:1 가드 → expected canonical
--   payload hash 생성 → upsert → DB 재조회 actual hash 검증
-- 을 통과했을 때만 status=complete 를 기록한다. 완료행을 먼저 쓰지 않는다(§11).
--
-- expected_payload_hash = §12 canonical payload hash:
--   PlayerGameLogRow 20필드 전체(메타 9 + 스탯 11)를 (kbo_id asc, player_type asc) 정렬 후
--   필드 "," / 행 "|" join, null은 "∅", sha256. key-only/13-tuple hash는 폐기(§12).

CREATE TABLE IF NOT EXISTS public.player_game_log_ingestions (
  game_id             text PRIMARY KEY,
  game_date           date NOT NULL,
  status              text NOT NULL CHECK (status IN ('complete', 'incomplete')),
  -- complete 판정 근거 (§11): expected = 파싱·resolve 통과한 canonical row set
  expected_row_count    integer,
  expected_payload_hash text,
  persisted_row_count   integer,
  unresolved_count      integer NOT NULL DEFAULT 0,
  source_fetched_at     timestamptz,
  verified_at           timestamptz,
  -- §12 실패 사유: missing_required_field | unresolved_player | row_count_mismatch |
  --               payload_hash_mismatch | boxscore_unavailable | score_unavailable
  failure_reason        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.player_game_log_ingestions IS
  '직관 통계 S1a: player_game_logs 경기별 적재 완료 증거 ledger (rev5 §11). service_role 전용.';

-- 집계 RPC(S1b)가 직관 game_id 목록으로 조회 — PK(game_id) 커버. 날짜 범위 backfill 점검용 보조 인덱스.
CREATE INDEX IF NOT EXISTS idx_pgl_ingestions_date
  ON public.player_game_log_ingestions (game_date);

-- RLS: 운영 내부 완료 증거 → service_role 전용. anon/authenticated 직접 read/write 차단
-- (완료 판정 조작 방지 — 클라이언트는 S1c API의 coverage 응답으로만 상태를 본다).
ALTER TABLE public.player_game_log_ingestions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_game_log_ingestions FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.player_game_log_ingestions TO service_role;
