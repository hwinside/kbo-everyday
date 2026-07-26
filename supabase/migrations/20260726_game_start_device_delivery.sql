-- 경기 시작 푸시: 게임 단위 boolean 선점 대신 "최초 대상 디바이스 스냅샷"별 전달 원장.
--
-- 불변식
-- 1) 한 게임의 스냅샷은 최초 1회만 생성한다. 이후 신규/교체 토큰은 catch-up하지 않는다.
-- 2) (game,event,token_id,token_hash)가 멱등 키다. 같은 id의 토큰 교체도 다른 hash로 구분한다.
-- 3) lease_token fencing을 통과한 worker만 결과를 기록한다.
-- 4) 최초 스냅샷의 transient 실패만 snapshot deadline(90초) 안에서 재시도한다.
-- 5) 스냅샷 모든 행이 terminal이 된 뒤에만 game_notify_state.start_notified=true로 종결한다.

create extension if not exists pgcrypto with schema extensions;

alter table game_notify_state
  add column if not exists start_snapshot_at timestamptz,
  add column if not exists start_snapshot_deadline_at timestamptz;

create table if not exists game_start_delivery_ledger (
  id uuid primary key default gen_random_uuid(),
  game_id text not null,
  event_type text not null default 'game_start' check (event_type = 'game_start'),
  token_id bigint not null,
  token_hash text not null,
  user_id uuid not null,
  platform text not null check (platform in ('ios', 'android')),
  -- transient 재시도 deadline 동안만 보관하고 terminal 전환 시 즉시 NULL로 지운다.
  -- 멱등/audit에는 token_hash만 남겨 원장에 활성 credential을 장기 보존하지 않는다.
  fcm_token text,
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'transient', 'accepted', 'permanent_failed', 'expired')),
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  deadline_at timestamptz not null,
  fcm_accepted_at timestamptz,
  device_delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, event_type, token_id, token_hash)
);

create index if not exists idx_game_start_delivery_claim
  on game_start_delivery_ledger (game_id, status, lease_until, id);

alter table game_start_delivery_ledger enable row level security;
-- 정책 없음: service_role cron 전용.

create or replace function snapshot_game_start_deliveries(
  p_game_id text,
  p_team_ids integer[],
  p_snapshot_at timestamptz,
  p_deadline_at timestamptz
)
returns timestamptz
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_created boolean := false;
  v_deadline timestamptz;
begin
  insert into game_notify_state (game_id)
  values (p_game_id)
  on conflict (game_id) do nothing;

  update game_notify_state
     set start_snapshot_at = p_snapshot_at,
         start_snapshot_deadline_at = p_deadline_at,
         updated_at = now()
   where game_id = p_game_id
     and start_notified = false
     and start_snapshot_at is null;

  v_created := found;
  if not v_created then
    select start_snapshot_deadline_at
      into v_deadline
      from game_notify_state
     where game_id = p_game_id;
    return v_deadline;
  end if;

  insert into game_start_delivery_ledger (
    game_id, token_id, token_hash, user_id, platform, fcm_token, deadline_at
  )
  select
    p_game_id,
    d.id,
    encode(extensions.digest(d.fcm_token, 'sha256'), 'hex'),
    d.user_id,
    d.platform,
    d.fcm_token,
    p_deadline_at
  from device_push_tokens d
  join profiles p on p.id = d.user_id
  left join notification_prefs np on np.user_id = d.user_id
  where p.team_id = any(p_team_ids)
    and coalesce(np.game_start, true)
  on conflict (game_id, event_type, token_id, token_hash) do nothing;

  return p_deadline_at;
end;
$$;

create or replace function claim_game_start_deliveries(
  p_game_id text,
  p_lease_token uuid,
  p_lease_seconds integer default 20,
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
    from game_start_delivery_ledger l
    where l.game_id = p_game_id
      and l.deadline_at > now()
      and (
        l.status in ('pending', 'transient')
        or (l.status = 'leased' and l.lease_until < now())
      )
      -- 1분 cron + 90초 snapshot에서 최초 시도 1회, transient 재시도 1회로 제한한다.
      and l.attempts < 2
      and l.fcm_token is not null
    -- 최초 미시도 전량이 transient retry에 굶지 않게 pending을 항상 먼저 drain한다.
    order by case l.status when 'pending' then 0 when 'transient' then 1 else 2 end, l.id
    for update skip locked
    limit greatest(1, least(p_limit, 500))
  ),
  claimed as (
    update game_start_delivery_ledger l
       set status = 'leased',
           attempts = l.attempts + 1,
           lease_token = p_lease_token,
           -- 호출부의 FCM transport는 8초로 bound된다. 20초 lease가 send+settle을
           -- 감싸 중첩 발송을 막고, crash 시 다음 1분 cron에는 만료돼 90초 안 재claim된다.
           lease_until = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 30))),
           updated_at = now()
      from candidates c
     where l.id = c.id
    returning l.id, l.token_id, l.token_hash, l.platform, l.fcm_token, l.deadline_at
  )
  select * from claimed;
$$;

create or replace function settle_game_start_deliveries(
  p_ids uuid[],
  p_lease_token uuid,
  p_status text,
  p_error text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_status not in ('accepted', 'transient', 'permanent_failed') then
    raise exception 'invalid delivery status';
  end if;

  update game_start_delivery_ledger
     set status = p_status,
         fcm_accepted_at = case when p_status = 'accepted' then now() else fcm_accepted_at end,
         last_error = p_error,
         fcm_token = case
           when p_status in ('accepted', 'permanent_failed') then null
           else fcm_token
         end,
         lease_token = null,
         lease_until = null,
         updated_at = now()
   where id = any(p_ids)
     and status = 'leased'
     and lease_token = p_lease_token;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function finalize_game_start_deliveries(p_game_id text)
returns table (
  snapshot_completed boolean,
  accepted bigint,
  device_delivered bigint,
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
  select start_snapshot_deadline_at
    into v_deadline
    from game_notify_state
   where game_id = p_game_id;

  if v_deadline is not null and now() >= v_deadline then
    update game_start_delivery_ledger
       set status = 'expired',
           lease_token = null,
           lease_until = null,
           last_error = coalesce(last_error, 'snapshot_deadline_exceeded'),
           fcm_token = null,
           updated_at = now()
     where game_id = p_game_id
       and (
         status in ('pending', 'transient')
         or (status = 'leased' and lease_until < now())
       );
  end if;

  return query
  with counts as (
    select
      count(*) filter (where status = 'accepted')::bigint as accepted,
      -- device ACK writer 도입 전에는 0이 아니라 미계측(NULL)이다.
      null::bigint as device_delivered,
      count(*) filter (where status in ('pending', 'leased', 'transient'))::bigint as pending,
      count(*) filter (where status = 'permanent_failed')::bigint as permanent_failed,
      count(*) filter (where status = 'expired')::bigint as expired
    from game_start_delivery_ledger
    where game_id = p_game_id
  ),
  completed as (
    update game_notify_state
       set start_notified = true,
           updated_at = now()
     where game_id = p_game_id
       and start_snapshot_at is not null
       and (select counts.pending from counts) = 0
    returning true
  )
  select
    coalesce((select true from completed), false),
    counts.accepted,
    counts.device_delivered,
    counts.pending,
    counts.permanent_failed,
    counts.expired
  from counts;
end;
$$;

revoke all on function snapshot_game_start_deliveries(text, integer[], timestamptz, timestamptz) from anon, authenticated, public;
revoke all on function claim_game_start_deliveries(text, uuid, integer, integer) from anon, authenticated, public;
revoke all on function settle_game_start_deliveries(uuid[], uuid, text, text) from anon, authenticated, public;
revoke all on function finalize_game_start_deliveries(text) from anon, authenticated, public;
grant execute on function snapshot_game_start_deliveries(text, integer[], timestamptz, timestamptz) to service_role;
grant execute on function claim_game_start_deliveries(text, uuid, integer, integer) to service_role;
grant execute on function settle_game_start_deliveries(uuid[], uuid, text, text) to service_role;
grant execute on function finalize_game_start_deliveries(text) to service_role;
