-- ⓕ warmup enrichObs 발현 틱 적재 (2026-08-28 삼순 제안·하린아빠 수용)
--
-- 배경: warmup cron 틱의 응답 body 는 Vercel 이 저장하지 않아 mode B(stale-equal)
-- 판독이 수동 GET 스팟 표본(~1.5%)에 의존했다. 발현 틱(score-src=schedule/frames·
-- relay-failed·deadline-cut)만 이 테이블에 남기면 cron 전 틱이 전수로 남는다.
-- "무발현 = 행 없음" 계약 — 정상 relay 틱은 쓰지 않아 write 부하 최소.

create table public.warmup_enrich_obs (
  id bigint generated always as identity primary key,
  -- 행 적재 시각(GC 기준). tick_at_ms 는 그 라운드 관측 시각(trace.fetchedAtMs).
  observed_at timestamptz not null default now(),
  tick_at_ms bigint not null,
  tick_kind text not null check (tick_kind in ('initial', 'subtick')),
  live_source text not null,
  live_stage text not null,
  -- enrichObs 항목: "<gameId>:score-src=relay|schedule|frames" | "<gameId>:relay-failed" | "<gameId>:deadline-cut"
  obs text[] not null
);

comment on table public.warmup_enrich_obs is
  'warmup relay enrich 발현 틱 관측 (service_role write-only, 판독용. 보존 14일 — warmup 정시 틱 기회적 GC).';

-- 판독 패턴: 경기일 시간 범위 조회. GC 패턴: observed_at < now() - 14d.
create index warmup_enrich_obs_observed_at_idx
  on public.warmup_enrich_obs (observed_at);

alter table public.warmup_enrich_obs enable row level security;

-- 정책 없음 = service_role(warmup cron·판독 스크립트)만 read/write. 클라이언트 노출 없음.
