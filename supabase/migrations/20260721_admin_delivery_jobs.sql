-- 관리자 대량 발송 원장 + 쪽지 outbox.
-- HTTP 요청에서 1만+ 유저를 순차 처리하지 않고, DB에서 대상을 원자적으로 스냅샷한 뒤
-- 크론이 lease/멱등키 기반으로 나눠 발송한다. service_role 전용(RLS 정책 없음).

create table if not exists admin_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('broadcast_dm', 'manual_push')),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'completed_with_failures')),
  sender_id uuid,
  content text,
  title text,
  body text,
  url text,
  target_label text not null,
  target_team_ids integer[],
  expected_count integer not null default 0 check (expected_count >= 0),
  selected_count integer not null default 0 check (selected_count >= 0),
  token_count integer not null default 0 check (token_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table admin_delivery_jobs enable row level security;
create index if not exists idx_admin_delivery_jobs_created
  on admin_delivery_jobs (created_at desc);
create index if not exists idx_admin_delivery_jobs_pending
  on admin_delivery_jobs (created_at)
  where kind = 'broadcast_dm' and status in ('queued', 'processing');

create table if not exists admin_broadcast_recipients (
  job_id uuid not null references admin_delivery_jobs(id) on delete cascade,
  user_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  claimed_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  primary key (job_id, user_id)
);

alter table admin_broadcast_recipients enable row level security;
create index if not exists idx_admin_broadcast_recipients_claim
  on admin_broadcast_recipients (job_id, status, claimed_at);

-- 대상 count와 실제 recipient insert를 같은 트랜잭션에서 대조한다. PostgREST의 1,000행
-- 응답 상한을 거치지 않으므로 전체/팀별 대상이 아무리 늘어도 누락 없이 스냅샷된다.
create or replace function create_admin_broadcast_job(
  p_sender_id uuid,
  p_content text,
  p_target_label text,
  p_team_ids integer[] default null
) returns table (job_id uuid, expected_count integer, selected_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_id uuid;
  v_expected integer;
  v_selected integer;
  v_teams integer[];
begin
  if p_sender_id is null or nullif(btrim(p_content), '') is null then
    raise exception 'sender and content are required';
  end if;

  if p_team_ids is null or cardinality(p_team_ids) = 0 then
    v_teams := null;
  else
    select array(select distinct x from unnest(p_team_ids) x where x between 1 and 10 order by x)
      into v_teams;
    if cardinality(v_teams) <> cardinality(p_team_ids) then
      raise exception 'team ids must be unique integers between 1 and 10';
    end if;
    if cardinality(v_teams) = 10 then
      v_teams := null;
    end if;
  end if;

  select count(*)::integer into v_expected
    from profiles p
   where p.id <> p_sender_id
     and (v_teams is null or p.team_id = any(v_teams));

  insert into admin_delivery_jobs (
    kind, sender_id, content, target_label, target_team_ids, expected_count
  ) values (
    'broadcast_dm', p_sender_id, btrim(p_content), p_target_label, v_teams, v_expected
  ) returning id into v_job_id;

  insert into admin_broadcast_recipients (job_id, user_id)
  select v_job_id, p.id
    from profiles p
   where p.id <> p_sender_id
     and (v_teams is null or p.team_id = any(v_teams));
  get diagnostics v_selected = row_count;

  if v_selected <> v_expected then
    raise exception 'broadcast target mismatch: expected %, selected %', v_expected, v_selected;
  end if;

  update admin_delivery_jobs
     set selected_count = v_selected,
         status = case when v_selected = 0 then 'completed' else 'queued' end,
         completed_at = case when v_selected = 0 then now() else null end
   where id = v_job_id;

  return query select v_job_id, v_expected, v_selected;
end;
$$;

revoke all on function create_admin_broadcast_job(uuid, text, text, integer[])
  from public, anon, authenticated;
grant execute on function create_admin_broadcast_job(uuid, text, text, integer[])
  to service_role;

-- pending 또는 lease가 만료된 processing 행을 원자적으로 선점한다. 겹친 크론도
-- FOR UPDATE SKIP LOCKED 덕분에 같은 수신자를 동시에 처리하지 않는다.
create or replace function claim_admin_broadcast_recipients(
  p_limit integer default 50,
  p_lease_seconds integer default 300,
  p_max_attempts integer default 10
) returns table (
  job_id uuid,
  user_id uuid,
  sender_id uuid,
  content text,
  attempts integer
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select r.job_id, r.user_id
      from admin_broadcast_recipients r
      join admin_delivery_jobs j on j.id = r.job_id
     where j.kind = 'broadcast_dm'
       and j.status in ('queued', 'processing')
       and r.attempts < greatest(p_max_attempts, 1)
       and (
         r.status = 'pending'
         or (r.status = 'processing' and r.claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 1)))
       )
     order by j.created_at, r.user_id
     for update of r skip locked
     limit greatest(p_limit, 1)
  ), claimed as (
    update admin_broadcast_recipients r
       set status = 'processing', claimed_at = now(), attempts = r.attempts + 1
      from candidates c
     where r.job_id = c.job_id and r.user_id = c.user_id
    returning r.job_id, r.user_id, r.attempts
  ), started as (
    update admin_delivery_jobs j
       set status = 'processing', started_at = coalesce(j.started_at, now())
     where j.id in (select distinct c.job_id from claimed c)
    returning j.id
  )
  select c.job_id, c.user_id, j.sender_id, j.content, c.attempts
    from claimed c
    join admin_delivery_jobs j on j.id = c.job_id
   where exists (select 1 from started s where s.id = c.job_id)
   order by j.created_at, c.user_id;
$$;

revoke all on function claim_admin_broadcast_recipients(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function claim_admin_broadcast_recipients(integer, integer, integer)
  to service_role;

-- 한 수신자의 처리 결과와 job 집계를 한 트랜잭션에서 갱신한다. 일시 실패는 pending으로
-- 되돌리고, 최대 시도에 도달한 건만 영구 failed로 확정한다.
create or replace function finish_admin_broadcast_recipient(
  p_job_id uuid,
  p_user_id uuid,
  p_ok boolean,
  p_error text default null,
  p_max_attempts integer default 10
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts integer;
  v_status text;
  v_terminal boolean;
  v_sent_delta integer;
  v_failed_delta integer;
begin
  select attempts, status into v_attempts, v_status
    from admin_broadcast_recipients
   where job_id = p_job_id and user_id = p_user_id
   for update;
  if not found then
    raise exception 'broadcast recipient not found';
  end if;
  if v_status in ('sent', 'failed') then
    return;
  end if;

  v_terminal := p_ok or v_attempts >= greatest(p_max_attempts, 1);
  v_sent_delta := case when p_ok then 1 else 0 end;
  v_failed_delta := case when not p_ok and v_terminal then 1 else 0 end;

  update admin_broadcast_recipients
     set status = case
           when p_ok then 'sent'
           when v_attempts >= greatest(p_max_attempts, 1) then 'failed'
           else 'pending'
         end,
         delivered_at = case when p_ok then now() else delivered_at end,
         claimed_at = null,
         last_error = case when p_ok then null else left(coalesce(p_error, 'send_failed'), 500) end
   where job_id = p_job_id and user_id = p_user_id;

  update admin_delivery_jobs
     set sent_count = sent_count + v_sent_delta,
         failed_count = failed_count + v_failed_delta,
         status = case
           when sent_count + v_sent_delta + failed_count + v_failed_delta < selected_count then 'processing'
           when failed_count + v_failed_delta = 0 then 'completed'
           else 'completed_with_failures'
         end,
         completed_at = case
           when sent_count + v_sent_delta + failed_count + v_failed_delta = selected_count then now()
           else null
         end,
         last_error = case when p_ok then last_error else left(coalesce(p_error, 'send_failed'), 500) end
   where id = p_job_id;
end;
$$;

revoke all on function finish_admin_broadcast_recipient(uuid, uuid, boolean, text, integer)
  from public, anon, authenticated;
grant execute on function finish_admin_broadcast_recipient(uuid, uuid, boolean, text, integer)
  to service_role;
