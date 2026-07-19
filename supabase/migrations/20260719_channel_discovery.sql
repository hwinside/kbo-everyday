-- 자동 채널 발굴 크론 — 실행/후보 판정 로그 + 동시실행 lock
-- Spec: 삼순 조건부 GO (2026-07-19 #cs "유사 채널 자동 발굴 크론")
--   · 첫 2회는 shadow(로그만, channel_pool 미변경) → 이후 자동 활성
--   · 활성 게이트: 최근 10개 중 KBO 8개+, duration≤70초 3개+, 30일 내 업로드
--   · 실행당 최대 5채널, quota fail-closed, 동시실행 lock, 후보별 판정사유 로그
--   · shadow 후보는 channel_pool inactive로 넣지 않는다(죽인 채널/미승인 후보 구분 유지)

-- 1. 실행 로그 (run 단위)
create table if not exists channel_discovery_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  mode text not null check (mode in ('shadow', 'active')),
  queries text[] not null default '{}',
  candidates_found int not null default 0,
  verified int not null default 0,
  activated int not null default 0,
  quota_used int not null default 0,
  degraded boolean not null default false,
  summary text
);

comment on table channel_discovery_runs is '자동 채널 발굴 크론 실행 로그 (첫 2회 shadow, 이후 active)';

-- 2. 후보별 판정 로그 (오탐 추적/재평가용)
create table if not exists channel_discovery_candidates (
  id bigserial primary key,
  run_id bigint not null references channel_discovery_runs(id) on delete cascade,
  channel_id text not null,
  channel_name text,
  seen_count int not null default 1,
  decision text not null check (decision in (
    'activated', 'rejected', 'shadow_pass', 'shadow_fail', 'unverified'
  )),
  reason text,
  kbo_count int,
  kbo_considered int,
  short_count int,
  recent_upload_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_cdc_run on channel_discovery_candidates(run_id);
create index if not exists idx_cdc_channel on channel_discovery_candidates(channel_id);

comment on table channel_discovery_candidates is '발굴 후보별 판정사유 로그 (channel_pool 반영 여부와 무관하게 전부 기록)';

-- 3. 동시실행 lock (단일 행)
create table if not exists channel_discovery_lock (
  id int primary key default 1 check (id = 1),
  locked_at timestamptz
);

insert into channel_discovery_lock (id, locked_at)
values (1, null)
on conflict (id) do nothing;

comment on table channel_discovery_lock is '발굴 크론 동시실행 방지용 단일 lock 행 (id=1)';

-- RLS: 전부 service_role 전용 (내부 로그/lock)
alter table channel_discovery_runs enable row level security;
alter table channel_discovery_candidates enable row level security;
alter table channel_discovery_lock enable row level security;

create policy "cdr_service_all" on channel_discovery_runs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "cdc_service_all" on channel_discovery_candidates for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "cdl_service_all" on channel_discovery_lock for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
