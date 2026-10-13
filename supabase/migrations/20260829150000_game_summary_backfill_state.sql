-- AI 경기 요약 final 전이 백필 — per-game 유계 재시도 durable 상태 (2026-08-29 인시던트, 삼순 NO-GO ②축).
--
-- warmup 크론(매분)이 "final 인데 요약 row 없음" 경기를 자동 생성 트리거할 때,
-- 시도 횟수·마지막 시도 시각·영구 종결 플래그를 서버리스 인스턴스 간 durable 하게 보관한다.
-- 이게 없으면 생성이 계속 실패하는 경기(취소 후 정정 등 엣지)에 매분 영구 재시도가 된다.
--
-- 판정 로직은 TS 순수 함수(backfillRetryDecision)가 담당 — 여기는 상태 보관만.
-- 동시 warmup 겹침의 upsert race 는 최악 "시도 1회 더"일 뿐이며, 실제 생성 중복은
-- /api/game-summary 의 claim lease(single-flight)가 차단한다.

create table if not exists public.game_summary_backfill_state (
  game_id text primary key,
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  gave_up boolean not null default false
);

alter table public.game_summary_backfill_state enable row level security;

-- service_role 전용(warmup 크론). 클라이언트 노출 없음 — RLS enable + policy 0 = anon/authenticated 전면 차단.
revoke all on table public.game_summary_backfill_state from public, anon, authenticated;
grant select, insert, update, delete on table public.game_summary_backfill_state to service_role;
