-- 경기 시작알림 peak fanout 보강.
-- 1) 한 사용자의 최신 last_seen 토큰을 같은 사용자의 구 토큰보다 먼저 시도한다.
-- 2) pending 전량을 transient retry보다 먼저 claim한다.

alter table game_start_delivery_ledger
  add column if not exists is_primary_token boolean not null default false;

with latest as (
  select distinct on (d.user_id)
    d.user_id,
    d.id
  from device_push_tokens d
  order by d.user_id, d.last_seen desc nulls last, d.created_at desc nulls last, d.id desc
)
update game_start_delivery_ledger l
   set is_primary_token = (l.token_id = latest.id)
  from latest
 where l.user_id = latest.user_id
   and l.status in ('pending', 'leased', 'transient');

create index if not exists idx_game_start_delivery_priority_claim
  on game_start_delivery_ledger (
    game_id,
    status,
    is_primary_token desc,
    next_attempt_at,
    lease_until,
    id
  );

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

  with eligible_tokens as (
    select
      d.*,
      row_number() over (
        partition by d.user_id
        order by d.last_seen desc nulls last, d.created_at desc nulls last, d.id desc
      ) = 1 as is_primary_token
    from device_push_tokens d
    join profiles p on p.id = d.user_id
    left join notification_prefs np on np.user_id = d.user_id
    where p.team_id = any(p_team_ids)
      and coalesce(np.game_start, true)
  )
  insert into game_start_delivery_ledger (
    game_id,
    token_id,
    token_hash,
    user_id,
    platform,
    fcm_token,
    deadline_at,
    is_primary_token
  )
  select
    p_game_id,
    d.id,
    encode(extensions.digest(d.fcm_token, 'sha256'), 'hex'),
    d.user_id,
    d.platform,
    d.fcm_token,
    p_deadline_at,
    d.is_primary_token
  from eligible_tokens d
  on conflict (game_id, event_type, token_id, token_hash) do nothing;

  return p_deadline_at;
end;
$$;

create or replace function claim_game_start_deliveries(
  p_game_id text,
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
    from game_start_delivery_ledger l
    where l.game_id = p_game_id
      and l.deadline_at > now()
      and l.next_attempt_at <= now()
      and (
        l.status in ('pending', 'transient')
        or (
          l.status = 'leased'
          and l.dispatch_started_at is null
          and l.lease_until < now()
        )
      )
      and l.attempts < 2
      and l.fcm_token is not null
    order by
      -- 미시도 우선: pending(0) → 만료된 pre-dispatch leased(1, send 미시작 crash 복구) → transient(2, 이미 1회 이상 시도).
      -- candidates에 포함되는 leased는 dispatch_started_at is null + lease_until < now()뿐이므로 status='leased' = 미시도 crash 행이다.
      case l.status when 'pending' then 0 when 'leased' then 1 else 2 end,
      l.is_primary_token desc,
      l.id
    for update skip locked
    limit greatest(1, least(p_limit, 500))
  ),
  claimed as (
    update game_start_delivery_ledger l
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

revoke all on function snapshot_game_start_deliveries(text, integer[], timestamptz, timestamptz)
  from anon, authenticated, public;
revoke all on function claim_game_start_deliveries(text, uuid, integer, integer)
  from anon, authenticated, public;
grant execute on function snapshot_game_start_deliveries(text, integer[], timestamptz, timestamptz)
  to service_role;
grant execute on function claim_game_start_deliveries(text, uuid, integer, integer)
  to service_role;
