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
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  -- FCM 외부 부작용 직전 durable intent. 값이 있으면 accepted 여부가 모호해도 재발송하지 않는다
  -- (at-most-once 선택); claim 직후 intent 전 crash만 deadline 안 재claim한다.
  dispatch_started_at timestamptz,
  deadline_at timestamptz not null,
  fcm_accepted_at timestamptz,
  device_delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, event_type, token_id, token_hash)
);

create index if not exists idx_game_start_delivery_claim
  on game_start_delivery_ledger (game_id, status, next_attempt_at, lease_until, id);

alter table game_start_delivery_ledger enable row level security;
-- 정책 없음: service_role cron 전용.

-- 최애선수 이벤트는 token별 start barrier를 통과한 device만 독립적으로 1회 선점한다.
-- game-global dedup은 accepted/OFF token의 즉시 release와 pending token의 후속 release를
-- 동시에 만족할 수 없으므로 별도 device 원장을 둔다.
create table if not exists notified_player_highlight_tokens (
  event_id text not null,
  game_id text not null,
  token_id bigint not null,
  token_hash text not null,
  start_required boolean not null,
  status text not null default 'waiting'
    check (status in ('waiting', 'leased', 'transient', 'accepted', 'permanent_failed', 'expired')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  accepted_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, token_id, token_hash)
);

create index if not exists idx_player_highlight_token_claim
  on notified_player_highlight_tokens (event_id, status, next_attempt_at, lease_until, token_id);

alter table notified_player_highlight_tokens enable row level security;

create table if not exists player_highlight_event_snapshots (
  event_id text primary key,
  game_id text not null,
  player_id text not null,
  pref_key text not null
    check (pref_key in ('fav_player_highlight', 'fav_player_strikeout')),
  start_team_ids integer[] not null,
  push_title text not null,
  push_body text not null,
  push_url text not null,
  snapshot_completed boolean not null default false,
  deadline_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table player_highlight_event_snapshots enable row level security;

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
           -- 호출부의 FCM transport는 8초, send+settle attempt는 14초로 bound된다.
           -- 45초 lease는 pre-dispatch crash가 다음 1분 cron에서 deadline 안 재claim되게 한다.
           lease_until = now() + make_interval(secs => greatest(20, least(p_lease_seconds, 45))),
           updated_at = now()
      from candidates c
     where l.id = c.id
    returning l.id, l.token_id, l.token_hash, l.platform, l.fcm_token, l.deadline_at
  )
  select * from claimed;
$$;

create or replace function mark_game_start_deliveries_dispatching(
  p_ids uuid[],
  p_lease_token uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update game_start_delivery_ledger
     set dispatch_started_at = now(),
         -- 외부 FCM accepted→DB settle 모호 구간은 snapshot deadline까지 재claim 금지.
         lease_until = deadline_at,
         updated_at = now()
   where id = any(p_ids)
     and status = 'leased'
     and lease_token = p_lease_token
     and dispatch_started_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
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
         next_attempt_at = case
           when p_status = 'transient'
             then least(deadline_at, now() + interval '45 seconds')
           else next_attempt_at
         end,
         dispatch_started_at = case
           when p_status = 'transient' then null
           else dispatch_started_at
         end,
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

-- 한 FCM batch의 accepted/transient/permanent 결과를 단일 transaction/RPC로 settle한다.
-- 3개 순차 RPC가 lease 전체를 소진해 accepted 행이 재claim되는 경계를 제거한다.
create or replace function settle_game_start_delivery_batch(
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
    update game_start_delivery_ledger l
       set status = r.status,
           fcm_accepted_at = case when r.status = 'accepted' then now() else l.fcm_accepted_at end,
           last_error = r.error,
           next_attempt_at = case
             when r.status = 'transient'
               then least(l.deadline_at, now() + interval '45 seconds')
             else l.next_attempt_at
           end,
           dispatch_started_at = case
             when r.status = 'transient' then null
             else l.dispatch_started_at
           end,
           fcm_token = case
             when r.status in ('accepted', 'permanent_failed') then null
             else l.fcm_token
           end,
           lease_token = null,
           lease_until = null,
           updated_at = now()
      from result_rows r
     where l.id = r.id
       and l.status = 'leased'
       and l.lease_token = p_lease_token
    returning r.status
  )
  select count(*) filter (where status = 'accepted')
    into v_accepted
    from changed;
  return coalesce(v_accepted, 0);
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

create or replace function claim_player_highlight_tokens(
  p_event_id text,
  p_game_id text,
  p_start_team_ids integer[],
  p_user_ids uuid[],
  p_pref_key text,
  p_finalize_snapshot boolean,
  p_start_accepted_before timestamptz,
  p_lease_token uuid,
  p_lease_seconds integer default 20,
  p_limit integer default 500,
  p_player_id text default '',
  p_push_title text default '',
  p_push_body text default '',
  p_push_url text default ''
)
returns table (token_id bigint, token_hash text, fcm_token text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_snapshot_completed boolean;
begin
  if p_pref_key not in ('fav_player_highlight', 'fav_player_strikeout') then
    raise exception 'invalid player highlight preference';
  end if;

  insert into player_highlight_event_snapshots (
    event_id, game_id, player_id, pref_key, start_team_ids,
    push_title, push_body, push_url,
    snapshot_completed, deadline_at, completed_at
  )
  select
    p_event_id,
    p_game_id,
    p_player_id,
    p_pref_key,
    p_start_team_ids,
    p_push_title,
    p_push_body,
    p_push_url,
    exists (
      select 1 from notified_score_events e where e.event_id = p_event_id
    ),
    now() + interval '30 minutes',
    case
      when exists (select 1 from notified_score_events e where e.event_id = p_event_id)
        then now()
      else null
    end
  on conflict (event_id) do nothing;

  select snapshot_completed
    into v_snapshot_completed
    from player_highlight_event_snapshots
   where event_id = p_event_id
     and game_id = p_game_id;

  if not coalesce(v_snapshot_completed, false) then
    -- fan ids는 호출부가 200명씩 append한다. snapshot 완료 전까지만 토큰을 받으므로
    -- 이후 최애선수를 추가한 유저에게 과거 이벤트가 뒤늦게 가지 않는다.
    insert into notified_player_highlight_tokens (
      event_id, game_id, token_id, token_hash, start_required
    )
    select
      p_event_id,
      p_game_id,
      d.id,
      encode(extensions.digest(d.fcm_token, 'sha256'), 'hex'),
      -- barrier는 이 token이 해당 경기 시작알림 audience(양 팀 팬+ON)일 때만 필요하다.
      -- 타팀 선수 팬은 start ledger가 없어도 활약알림을 정상 release한다.
      coalesce(np.game_start, true) and p.team_id = any(p_start_team_ids)
    from device_push_tokens d
    join profiles p on p.id = d.user_id
    left join notification_prefs np on np.user_id = d.user_id
    where d.user_id = any(p_user_ids)
      and case p_pref_key
        when 'fav_player_highlight' then coalesce(np.fav_player_highlight, true)
        when 'fav_player_strikeout' then coalesce(np.fav_player_strikeout, true)
        else false
      end
    on conflict on constraint notified_player_highlight_tokens_pkey do nothing;
  end if;

  if p_finalize_snapshot and not coalesce(v_snapshot_completed, false) then
    update player_highlight_event_snapshots
       set snapshot_completed = true,
           completed_at = now()
     where event_id = p_event_id
       and game_id = p_game_id
       and snapshot_completed = false;

    -- 기존 global event namespace도 snapshot 완료 시 함께 마킹해 배포 전 이벤트와
    -- 신규 token 원장의 audience freeze 의미를 연결한다.
    insert into notified_score_events (event_id, game_id)
    values (p_event_id, p_game_id)
    on conflict (event_id) do nothing;
    v_snapshot_completed := true;
  end if;

  if not coalesce(v_snapshot_completed, false) then
    return;
  end if;

  -- source event freshness와 무관한 durable deadline. cron 공백 뒤 재개 시에도 이 함수가
  -- 기존 snapshot을 drain하며, deadline이 지난 미종결 행만 명시 expired로 닫는다.
  update notified_player_highlight_tokens n
     set status = 'expired',
         lease_token = null,
         lease_until = null,
         last_error = coalesce(last_error, 'highlight_deadline_exceeded'),
         updated_at = now()
    from player_highlight_event_snapshots s
   where n.event_id = p_event_id
     and n.game_id = p_game_id
     and s.event_id = n.event_id
     and s.deadline_at <= now()
     and n.status in ('waiting', 'leased', 'transient');

  return query
  with eligible as (
    select n.event_id, n.token_id, n.token_hash, d.fcm_token
    from notified_player_highlight_tokens n
    join device_push_tokens d
      on d.id = n.token_id
     and encode(extensions.digest(d.fcm_token, 'sha256'), 'hex') = n.token_hash
    where n.event_id = p_event_id
      and n.game_id = p_game_id
      and (
        n.status in ('waiting', 'transient')
        or (n.status = 'leased' and n.lease_until < now())
      )
      and n.next_attempt_at <= now()
      and exists (
        select 1
        from player_highlight_event_snapshots s
        where s.event_id = n.event_id
          and s.deadline_at > now()
      )
      and (
        -- game_start OFF는 start 계약의 명시적 bypass다.
        not n.start_required
        or exists (
          -- ON token은 같은 token id+credential hash의 FCM accepted 뒤에만 release한다.
          -- pending/transient/permanent/expired 및 mark-only(no ledger)는 해당 token만 보류한다.
          select 1
          from game_start_delivery_ledger l
          where l.game_id = p_game_id
            and l.token_id = n.token_id
            and l.token_hash = n.token_hash
            and l.status = 'accepted'
            -- 현재 분 tick 이전에 accepted된 start만 허용한다. 겹친 invocation이 같은
            -- nominal minute 안에서 50초 뒤 실행돼도 highlight를 먼저 풀지 않는다.
            and l.fcm_accepted_at < p_start_accepted_before
        )
      )
    for update of n skip locked
    limit greatest(1, least(p_limit, 500))
  ),
  claimed as (
    update notified_player_highlight_tokens n
       set status = 'leased',
           attempts = n.attempts + 1,
           lease_token = p_lease_token,
           lease_until = now() + make_interval(secs => greatest(1, p_lease_seconds)),
           updated_at = now()
      from eligible e
     where n.event_id = e.event_id
       and n.token_id = e.token_id
       and n.token_hash = e.token_hash
    returning n.token_id, n.token_hash
  )
  select e.token_id, e.token_hash, e.fcm_token
  from eligible e
  join claimed c using (token_id, token_hash);
end;
$$;

create or replace function list_due_player_highlight_snapshots(
  p_limit integer default 50,
  p_start_accepted_before timestamptz default date_trunc('minute', now())
)
returns table (
  event_id text,
  game_id text,
  player_id text,
  pref_key text,
  start_team_ids integer[],
  push_title text,
  push_body text,
  push_url text,
  snapshot_completed boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- source game/event가 live payload에서 사라져도 deadline terminalization은 계속된다.
  update notified_player_highlight_tokens n
     set status = 'expired',
         lease_token = null,
         lease_until = null,
         last_error = coalesce(last_error, 'highlight_deadline_exceeded'),
         updated_at = now()
    from player_highlight_event_snapshots s
   where s.event_id = n.event_id
     and s.deadline_at <= now()
     and n.status in ('waiting', 'leased', 'transient');

  return query
  select
    s.event_id,
    s.game_id,
    s.player_id,
    s.pref_key,
    s.start_team_ids,
    s.push_title,
    s.push_body,
    s.push_url,
    s.snapshot_completed
  from player_highlight_event_snapshots s
  where s.deadline_at > now()
    and (
      not s.snapshot_completed
      or exists (
        select 1
        from notified_player_highlight_tokens n
        join device_push_tokens d
          on d.id = n.token_id
         and encode(extensions.digest(d.fcm_token, 'sha256'), 'hex') = n.token_hash
        where n.event_id = s.event_id
          and (
            n.status in ('waiting', 'transient')
            or (n.status = 'leased' and n.lease_until < now())
          )
          and n.next_attempt_at <= now()
          and (
            not n.start_required
            or exists (
              select 1
              from game_start_delivery_ledger l
              where l.game_id = s.game_id
                and l.token_id = n.token_id
                and l.token_hash = n.token_hash
                and l.status = 'accepted'
                and l.fcm_accepted_at < p_start_accepted_before
            )
          )
      )
    )
  -- completed+claimable work outranks incomplete recovery. start-blocked/deleted credentials
  -- do not occupy the bounded page and starve a later deliverable snapshot.
  order by s.snapshot_completed desc, s.created_at, s.event_id
  limit greatest(1, least(p_limit, 50));
end;
$$;

create or replace function settle_player_highlight_tokens(
  p_results jsonb,
  p_lease_token uuid
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_accepted integer;
begin
  with incoming as (
    select
      (r->>'token_id')::bigint as token_id,
      r->>'token_hash' as token_hash,
      r->>'status' as status,
      nullif(r->>'error', '') as error
    from jsonb_array_elements(p_results) r
  ),
  settled as (
    update notified_player_highlight_tokens n
       set status = case
             when i.status = 'accepted' then 'accepted'
             when i.status = 'transient' then 'transient'
             else 'permanent_failed'
           end,
           next_attempt_at = case
             when i.status = 'transient'
               then now() + interval '45 seconds'
             else n.next_attempt_at
           end,
           accepted_at = case when i.status = 'accepted' then now() else n.accepted_at end,
           last_error = i.error,
           lease_token = null,
           lease_until = null,
           updated_at = now()
      from incoming i
     where n.token_id = i.token_id
       and n.token_hash = i.token_hash
       and n.status = 'leased'
       and n.lease_token = p_lease_token
    returning n.status
  )
  select count(*) filter (where status = 'accepted') into v_accepted from settled;
  return coalesce(v_accepted, 0);
end;
$$;

revoke all on function snapshot_game_start_deliveries(text, integer[], timestamptz, timestamptz) from anon, authenticated, public;
revoke all on function claim_game_start_deliveries(text, uuid, integer, integer) from anon, authenticated, public;
revoke all on function mark_game_start_deliveries_dispatching(uuid[], uuid) from anon, authenticated, public;
revoke all on function settle_game_start_deliveries(uuid[], uuid, text, text) from anon, authenticated, public;
revoke all on function settle_game_start_delivery_batch(jsonb, uuid) from anon, authenticated, public;
revoke all on function finalize_game_start_deliveries(text) from anon, authenticated, public;
revoke all on function claim_player_highlight_tokens(text, text, integer[], uuid[], text, boolean, timestamptz, uuid, integer, integer, text, text, text, text) from anon, authenticated, public;
revoke all on function list_due_player_highlight_snapshots(integer, timestamptz) from anon, authenticated, public;
revoke all on function settle_player_highlight_tokens(jsonb, uuid) from anon, authenticated, public;
grant execute on function snapshot_game_start_deliveries(text, integer[], timestamptz, timestamptz) to service_role;
grant execute on function claim_game_start_deliveries(text, uuid, integer, integer) to service_role;
grant execute on function mark_game_start_deliveries_dispatching(uuid[], uuid) to service_role;
grant execute on function settle_game_start_deliveries(uuid[], uuid, text, text) to service_role;
grant execute on function settle_game_start_delivery_batch(jsonb, uuid) to service_role;
grant execute on function finalize_game_start_deliveries(text) to service_role;
grant execute on function claim_player_highlight_tokens(text, text, integer[], uuid[], text, boolean, timestamptz, uuid, integer, integer, text, text, text, text) to service_role;
grant execute on function list_due_player_highlight_snapshots(integer, timestamptz) to service_role;
grant execute on function settle_player_highlight_tokens(jsonb, uuid) to service_role;
