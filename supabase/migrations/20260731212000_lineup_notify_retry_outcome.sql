-- 라인업 확정 알림 transient 재시도/종결 상태 보강.
-- 이미 만료된 원장은 재발송하지 않고 terminal outcome/counter만 역산한다.

alter table game_lineup_notify_state
  add column if not exists delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'delivered', 'partial', 'failed')),
  add column if not exists accepted_count bigint not null default 0,
  add column if not exists permanent_failed_count bigint not null default 0,
  add column if not exists expired_count bigint not null default 0;

-- 기존 terminal 원장을 실제 ledger 결과로 분류한다. expired/transient 행은 건드리지 않아
-- 오늘 만료분이 다시 claim/발송되는 일은 없다.
with counts as (
  select
    s.game_id,
    s.team_id,
    count(l.*) filter (where l.status = 'accepted')::bigint as accepted,
    count(l.*) filter (where l.status in ('pending', 'leased', 'transient'))::bigint as pending,
    count(l.*) filter (where l.status = 'permanent_failed')::bigint as permanent_failed,
    count(l.*) filter (where l.status = 'expired')::bigint as expired
  from game_lineup_notify_state s
  left join lineup_confirm_delivery_ledger l
    on l.game_id = s.game_id and l.team_id = s.team_id
  where s.lineup_snapshot_at is not null
  group by s.game_id, s.team_id
), classified as (
  select *, case
    when pending > 0 then 'pending'
    when accepted > 0 and (permanent_failed > 0 or expired > 0) then 'partial'
    when accepted = 0 and (permanent_failed > 0 or expired > 0) then 'failed'
    else 'delivered'
  end as outcome
  from counts
)
update game_lineup_notify_state s
   set delivery_status = c.outcome,
       lineup_notified = (c.outcome = 'delivered'),
       accepted_count = c.accepted,
       permanent_failed_count = c.permanent_failed,
       expired_count = c.expired,
       updated_at = now()
  from classified c
 where s.game_id = c.game_id and s.team_id = c.team_id;

drop index if exists idx_lineup_notify_state_due;
create index idx_lineup_notify_state_due
  on game_lineup_notify_state (lineup_snapshot_deadline_at)
  where delivery_status = 'pending' and lineup_snapshot_at is not null;

-- pending 우선 공정 claim. transient는 snapshot deadline 안에서 최대 8회만 재시도한다.
-- 500-token transport 장애가 나도 backoff 중인 실패 batch보다 아직 미시도 pending이 먼저 drain된다.
create or replace function claim_lineup_confirm_deliveries(
  p_game_id text,
  p_team_id integer,
  p_lease_token uuid,
  p_lease_seconds integer default 45,
  p_limit integer default 500
)
returns table (
  id uuid,
  token_id bigint,
  token_hash text,
  platform text,
  fcm_token text,
  deadline_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select l.id
    from lineup_confirm_delivery_ledger l
    where l.game_id = p_game_id
      and l.team_id = p_team_id
      and l.deadline_at > now()
      and l.next_attempt_at <= now()
      and (
        l.status in ('pending', 'transient')
        or (l.status = 'leased' and l.dispatch_started_at is null and l.lease_until < now())
      )
      and l.attempts < 8
      and l.fcm_token is not null
    order by case l.status when 'pending' then 0 when 'transient' then 1 else 2 end,
             l.next_attempt_at,
             l.id
    for update skip locked
    limit greatest(1, least(p_limit, 500))
  ),
  claimed as (
    update lineup_confirm_delivery_ledger l
       set status = 'leased',
           attempts = l.attempts + 1,
           lease_token = p_lease_token,
           lease_until = now() + make_interval(secs => greatest(20, least(p_lease_seconds, 45))),
           updated_at = now()
      from candidates c
     where l.id = c.id
    returning l.id, l.token_id, l.token_hash, l.platform, l.fcm_token, l.deadline_at
  )
  select * from claimed;
$$;

-- transient backoff: 5, 10, 20, 40, 80, 120, 120초(항상 snapshot deadline으로 clamp).
create or replace function settle_lineup_confirm_delivery_batch(
  p_results jsonb,
  p_lease_token uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_accepted integer;
begin
  with result_rows as (
    select
      (r->>'id')::uuid as id,
      r->>'status' as status,
      nullif(r->>'error', '') as error
    from jsonb_array_elements(p_results) r
    where r->>'status' in ('accepted', 'transient', 'permanent_failed')
  ),
  changed as (
    update lineup_confirm_delivery_ledger l
       set status = r.status,
           fcm_accepted_at = case when r.status = 'accepted' then now() else l.fcm_accepted_at end,
           last_error = r.error,
           next_attempt_at = case
             when r.status = 'transient' then least(
               l.deadline_at,
               now() + make_interval(secs => least(
                 120,
                 5 * power(2, greatest(0, least(l.attempts - 1, 5)))::integer
               ))
             )
             else l.next_attempt_at
           end,
           dispatch_started_at = case when r.status = 'transient' then null else l.dispatch_started_at end,
           fcm_token = case when r.status in ('accepted', 'permanent_failed') then null else l.fcm_token end,
           lease_token = null,
           lease_until = null,
           updated_at = now()
      from result_rows r
     where l.id = r.id
       and l.status = 'leased'
       and l.lease_token = p_lease_token
    returning r.status
  )
  select count(*) filter (where status = 'accepted') into v_accepted from changed;
  return coalesce(v_accepted, 0);
end;
$$;

-- terminal은 delivered/partial/failed로 구분하고 카운터를 state에 보존한다.
create or replace function finalize_lineup_confirm_deliveries(
  p_game_id text,
  p_team_id integer
)
returns table (
  snapshot_completed boolean,
  accepted bigint,
  pending bigint,
  permanent_failed bigint,
  expired bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deadline timestamptz;
begin
  select lineup_snapshot_deadline_at into v_deadline
    from game_lineup_notify_state
   where game_id = p_game_id and team_id = p_team_id;

  if v_deadline is not null and now() >= v_deadline then
    update lineup_confirm_delivery_ledger
       set status = 'expired',
           lease_token = null,
           lease_until = null,
           last_error = coalesce(last_error, 'snapshot_deadline_exceeded'),
           fcm_token = null,
           updated_at = now()
     where game_id = p_game_id
       and team_id = p_team_id
       and (status in ('pending', 'transient') or (status = 'leased' and lease_until < now()));
  end if;

  return query
  with counts as (
    select
      count(*) filter (where status = 'accepted')::bigint as accepted,
      count(*) filter (where status in ('pending', 'leased', 'transient'))::bigint as pending,
      count(*) filter (where status = 'permanent_failed')::bigint as permanent_failed,
      count(*) filter (where status = 'expired')::bigint as expired
    from lineup_confirm_delivery_ledger
    where game_id = p_game_id and team_id = p_team_id
  ), classified as (
    select counts.*, case
      when counts.pending > 0 then 'pending'
      when counts.accepted > 0 and (counts.permanent_failed > 0 or counts.expired > 0) then 'partial'
      when counts.accepted = 0 and (counts.permanent_failed > 0 or counts.expired > 0) then 'failed'
      else 'delivered'
    end as outcome
    from counts
  ), saved as (
    update game_lineup_notify_state s
       set delivery_status = c.outcome,
           lineup_notified = (c.outcome = 'delivered'),
           accepted_count = c.accepted,
           permanent_failed_count = c.permanent_failed,
           expired_count = c.expired,
           updated_at = now()
      from classified c
     where s.game_id = p_game_id
       and s.team_id = p_team_id
    returning delivery_status
  )
  select
    c.pending = 0,
    c.accepted,
    c.pending,
    c.permanent_failed,
    c.expired
  from classified c;
end;
$$;

create or replace function list_due_lineup_confirm_snapshots(
  p_limit integer default 200
)
returns table (
  game_id text,
  team_id integer,
  snapshot_deadline_at timestamptz,
  push_title text,
  push_body text,
  push_url text
)
language sql
security definer
set search_path = public
as $$
  select s.game_id, s.team_id, s.lineup_snapshot_deadline_at, s.push_title, s.push_body, s.push_url
  from game_lineup_notify_state s
  where s.delivery_status = 'pending'
    and s.lineup_snapshot_at is not null
  order by s.lineup_snapshot_deadline_at asc nulls last, s.game_id, s.team_id
  limit greatest(1, least(p_limit, 500));
$$;
