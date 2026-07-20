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
  -- 'running' → 'success'|'error'. shadow 승격 카운트는 status='success' && degraded=false 인
  -- 완료된 shadow run만 포함(삼순 3번 반영: 오류/degraded run이 승격 카운트를 오염시키지 않게).
  status text not null default 'running' check (status in ('running', 'success', 'error')),
  queries text[] not null default '{}',
  candidates_found int not null default 0,
  verified int not null default 0,
  activated int not null default 0,
  quota_used int not null default 0,
  degraded boolean not null default false,
  summary text
);

comment on table channel_discovery_runs is '자동 채널 발굴 크론 실행 로그 (완료된 non-degraded shadow 2회 후 active)';

create index if not exists idx_cdr_shadow_promo
  on channel_discovery_runs(mode, status, degraded)
  where mode = 'shadow';

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

-- 4. 원자적 커밋 RPC (삼순 blocker 1: pool 반영 + 후보로그 + run 마감 진짜 원자적)
--    단일 트랜잭션(plpgsql 함수)으로 channel_pool 활성화 + run insert + 후보로그 insert 를
--    all-or-nothing 커밋. 어느 단계가 실패해도 전부 롤백.
--
-- 삼순 3차 NO-GO(1) 반영 — TOCTOU 방지:
--   발굴 스냅샷(existingIds) 이후 운영자가 채널을 channel_pool 에 비활성화 로 넣거나
--   다른 경로로 행이 생기면, 기존 ON CONFLICT DO UPDATE SET is_active=true 가 그 죽은
--   채널을 조용히 재활성화했다. → DO NOTHING 으로 바꿔 스냅샷 이후 존재하는 행은
--   절대 건드리지 않고(is_active 유지), 실제 insert 된 신규 채널만 activated 로 재산정.
--   conflict 로 스킵된 'activated' 후보로그는 'rejected'(conflict_skip) 로 강등.
-- degraded/shadow run 은 호출부가 p_activations=[] 로 넘겨 channel_pool 변경 0(blocker 2 하드 게이트).
drop function if exists commit_channel_discovery(text, text[], int, int, int, boolean, int, text, jsonb, jsonb);
create function commit_channel_discovery(
  p_mode text,
  p_queries text[],
  p_candidates_found int,
  p_verified int,
  p_quota_used int,
  p_degraded boolean,
  p_activated int,       -- 시도 활성화 수(참고). 실 저장값은 아래서 재산정한 actual.
  p_summary text,
  p_activations jsonb,   -- [{channel_id, channel_name}]  (active·non-degraded 일 때만 non-empty)
  p_candidates jsonb     -- [{channel_id, channel_name, seen_count, decision, reason,
                         --   kbo_count, kbo_considered, short_count, recent_upload_at}]
)
returns table(run_id bigint, activated int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id bigint;
  v_act jsonb;
  v_cand jsonb;
  v_cid text;
  v_inserted int;
  v_activated_actual int := 0;
  v_conflict_ids text[] := '{}';
  v_decision text;
  v_reason text;
begin
  if p_mode not in ('shadow', 'active') then
    raise exception 'invalid mode: %', p_mode using errcode = '22023';
  end if;
  -- degraded run 은 절대 channel_pool 을 건드리지 않는다(하드 게이트)
  if p_degraded and jsonb_array_length(coalesce(p_activations, '[]'::jsonb)) > 0 then
    raise exception 'degraded run must not activate channels' using errcode = '22023';
  end if;
  if p_mode = 'shadow' and jsonb_array_length(coalesce(p_activations, '[]'::jsonb)) > 0 then
    raise exception 'shadow run must not activate channels' using errcode = '22023';
  end if;

  -- 1) channel_pool 활성화 — DO NOTHING 으로 스냅샷 이후 생긴 행(운영자 비활성화 포함)은
  --    절대 재활성화하지 않는다(TOCTOU 방지). 실제 insert 된 신규 채널만 activated 로 산정.
  for v_act in select * from jsonb_array_elements(coalesce(p_activations, '[]'::jsonb))
  loop
    v_cid := v_act->>'channel_id';
    insert into channel_pool(channel_id, channel_name, tier, is_active, team_affinity)
    values (v_cid, coalesce(v_act->>'channel_name', v_cid), 3, true, null)
    on conflict (channel_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      v_activated_actual := v_activated_actual + 1;
    else
      -- 스냅샷 이후 이미 존재(신규 아님) → 재활성화 금지, 감사로그 강등 대상
      v_conflict_ids := array_append(v_conflict_ids, v_cid);
    end if;
  end loop;

  -- 2) run 을 실제 활성화 수(actual)로 기록
  insert into channel_discovery_runs(
    mode, status, queries, candidates_found, verified, quota_used, degraded, activated, summary
  ) values (
    p_mode, 'success', p_queries, p_candidates_found, p_verified, p_quota_used, p_degraded,
    v_activated_actual, p_summary
  ) returning id into v_run_id;

  -- 3) 후보 판정 로그 (run_id FK). conflict 로 스킵된 'activated' 후보는 'rejected'로 강등.
  for v_cand in select * from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
  loop
    v_cid := v_cand->>'channel_id';
    v_decision := v_cand->>'decision';
    v_reason := v_cand->>'reason';
    if v_decision = 'activated' and v_cid = any(v_conflict_ids) then
      v_decision := 'rejected';
      v_reason := 'conflict_skip: 스냅샷 이후 이미 channel_pool 에 존재(운영자 비활성화 가능) — 재활성화 안 함';
    end if;
    insert into channel_discovery_candidates(
      run_id, channel_id, channel_name, seen_count, decision, reason,
      kbo_count, kbo_considered, short_count, recent_upload_at
    ) values (
      v_run_id, v_cid, v_cand->>'channel_name',
      coalesce((v_cand->>'seen_count')::int, 1),
      v_decision, v_reason,
      (v_cand->>'kbo_count')::int,
      (v_cand->>'kbo_considered')::int,
      (v_cand->>'short_count')::int,
      (v_cand->>'recent_upload_at')::timestamptz
    );
  end loop;

  return query select v_run_id, v_activated_actual;
end;
$$;

comment on function commit_channel_discovery is
  '채널 발굴 결과 원자적 커밋 — channel_pool(DO NOTHING·TOCTOU 방지)+run(actual activated)+후보로그 단일 트랜잭션. service_role 전용.';

-- SECURITY DEFINER 함수는 RLS로 막히지 않으므로 명시적으로 권한 회수/부여
revoke all on function commit_channel_discovery(text, text[], int, int, int, boolean, int, text, jsonb, jsonb) from public;
revoke all on function commit_channel_discovery(text, text[], int, int, int, boolean, int, text, jsonb, jsonb) from anon;
revoke all on function commit_channel_discovery(text, text[], int, int, int, boolean, int, text, jsonb, jsonb) from authenticated;
grant execute on function commit_channel_discovery(text, text[], int, int, int, boolean, int, text, jsonb, jsonb) to service_role;
