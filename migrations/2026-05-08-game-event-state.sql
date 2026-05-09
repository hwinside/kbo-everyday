-- 2026-05-08 game_event_state 테이블 신설
-- 작성: 삼식이 / 리뷰: 삼순이 / 승인: 하린아빠 (옵션 W)
--
-- 배경:
--   - /api/game-events route의 prevStateCache + eventHistory가 Vercel
--     serverless instance별 in-memory Map이라 instance lottery 발생.
--   - 같은 game-events endpoint를 5번 연속 호출 시 K 카운트가
--     5/5/6/6/9로 매번 다른 history 반환 (2026-05-08 송승기 6연속 K
--     사례에서 사용자 체감).
--   - cron warmup이 한 instance에 채워둔 events history가 다른
--     instance에 떨어지는 client 요청에 전혀 전달되지 않음.
--   - 클라 useCelebration의 strikeoutCount가 instance 따라 random
--     ("그냥 삼진" 또는 "2K"부터 시작 등 사용자 보고).
--
-- 정책:
--   - prev_state, event_history를 game_id 기준 단일 row로 통합
--   - 모든 instance가 같은 row 참조 → instance lottery 제거
--   - event_history는 누적 jsonb (게임 종료 후 cleanup cron 별도)
--   - last-write-wins 단순 upsert (race condition은 다음 polling으로 정정)
--
-- 안전:
--   - IF NOT EXISTS 가드
--   - 기존 데이터 영향 없음 (신규 테이블)

BEGIN;

CREATE TABLE IF NOT EXISTS public.game_event_state (
  game_id        text PRIMARY KEY,
  prev_state     jsonb,
  event_history  jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT NOW()
);

-- updated_at index for cleanup queries (e.g. delete games older than 7 days)
CREATE INDEX IF NOT EXISTS idx_game_event_state_updated_at
  ON public.game_event_state (updated_at);

-- ========================================================================
-- Row-level security — table holds operational event state. Only
-- service_role (server-side /api/game-events) may read or write it;
-- anon and authenticated roles must never touch it directly.
--
-- Postgres treats a missing policy as deny under RLS. service_role
-- bypasses RLS by default in Supabase, so we enable RLS, intentionally
-- add no anon/authenticated policies, and revoke direct table grants for
-- defense in depth.
-- ========================================================================
ALTER TABLE public.game_event_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.game_event_state FROM anon, authenticated;

COMMENT ON TABLE public.game_event_state IS
  'Server-side shared game event state. Access restricted to service_role only — anon/authenticated must NOT read or write directly. All access goes through /api/game-events on the server.';

-- ========================================================================
-- Atomic upsert function — prevents read-modify-write race where two
-- concurrent pollers both read the same event_history, both append their
-- newEvents, and the later upsert clobbers the earlier one.
--
-- ON CONFLICT path dedupes by event.id (jsonb element ->> 'id') so a
-- retry/re-emit of the same logical event (e.g. two pollers minting an
-- identical id during a race, or a retry after partial failure)
-- collapses to one entry. DISTINCT ON keeps the earliest-timestamp copy.
-- prev_state remains last-write-wins (acceptable — it's derived from KBO
-- source each poll and self-heals on next call).
--
-- Returns the final event_history so the caller can render it without a
-- second SELECT race.
-- ========================================================================
CREATE OR REPLACE FUNCTION public.upsert_game_event_state(
  p_game_id     text,
  p_prev_state  jsonb,
  p_new_events  jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  final_history jsonb;
BEGIN
  INSERT INTO public.game_event_state (game_id, prev_state, event_history, updated_at)
  VALUES (p_game_id, p_prev_state, COALESCE(p_new_events, '[]'::jsonb), NOW())
  ON CONFLICT (game_id) DO UPDATE
    SET prev_state    = EXCLUDED.prev_state,
        event_history = COALESCE(
          (
            SELECT jsonb_agg(elem ORDER BY (elem->>'timestamp'))
            FROM (
              SELECT DISTINCT ON (elem->>'id') elem
              FROM jsonb_array_elements(
                public.game_event_state.event_history
                || COALESCE(EXCLUDED.event_history, '[]'::jsonb)
              ) AS t(elem)
              ORDER BY elem->>'id', (elem->>'timestamp')
            ) AS deduped
          ),
          '[]'::jsonb
        ),
        updated_at    = NOW()
  RETURNING event_history INTO final_history;

  RETURN final_history;
END;
$$;

-- Restrict RPC execution to service_role; same trust boundary as the table.
REVOKE EXECUTE ON FUNCTION public.upsert_game_event_state(text, jsonb, jsonb)
  FROM anon, authenticated, public;

COMMIT;
