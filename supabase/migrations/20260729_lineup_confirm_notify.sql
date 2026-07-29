-- 라인업 확정 푸시(최애팀 라인업 확정 즉시 1회) — 경기 시작 푸시(20260726)의 디바이스 스냅샷/전달
-- 원장 아키텍처를 (game_id, team_id) 단위로 클론한다. 최애팀별로 자기 팀 라인업 확정을 1회만 받는다.
--
-- 불변식 (하린아빠 스펙 gate ①②③)
-- 1) (game_id, team_id) 스냅샷은 미확정→확정 최초 1회만 생성한다(폴링/재배포/라인업 수정 중복 0).
-- 2) (game_id, team_id, event_type, token_id, token_hash)가 멱등 키다. 토큰 교체는 다른 hash로 구분.
-- 3) lease_token fencing을 통과한 worker만 결과를 기록한다. dispatch_started_at = at-most-once intent.
-- 4) 최초 스냅샷의 transient 실패만 snapshot deadline 안에서 재시도한다.
-- 5) 스냅샷 모든 행이 terminal이 된 뒤에만 game_lineup_notify_state.lineup_notified=true로 종결한다.
-- 6) 더블헤더는 KBO gameId(...0/...1)가 다르므로 자연히 분리된다. 취소/연기 fail-safe는 호출부(cron)에서
--    LINEUP_CK=true & 미취소일 때만 snapshot을 여는 것으로 보장한다.

create extension if not exists pgcrypto with schema extensions;

-- 최애팀 라인업 확정 알림 opt-in (기본 on; game_start 컬럼 미러). coalesce(...,true)로 미설정=on.
alter table notification_prefs
  add column if not exists lineup_confirm boolean not null default true;

-- (game_id, team_id) 단위 "확정 알림 1회" 게이트.
create table if not exists game_lineup_notify_state (
  game_id text not null,
  team_id integer not null,
  lineup_notified boolean not null default false,
  lineup_snapshot_at timestamptz,
  lineup_snapshot_deadline_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (game_id, team_id)
);

alter table game_lineup_notify_state enable row level security;
-- 정책 없음: service_role cron 전용.

create table if not exists lineup_confirm_delivery_ledger (
  id uuid primary key default gen_random_uuid(),
  game_id text not null,
  team_id integer not null,
  event_type text not null default 'lineup_confirm' check (event_type = 'lineup_confirm'),
  token_id bigint not null,
  token_hash text not null,
  user_id uuid not null,
  platform text not null check (platform in ('ios', 'android')),
  -- transient 재시도 deadline 동안만 보관, terminal 전환 시 NULL로 지운다(활성 credential 장기 미보존).
  fcm_token text,
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'transient', 'accepted', 'permanent_failed', 'expired')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  -- FCM 외부 부작용 직전 durable intent. 값 있으면 accepted 모호해도 재발송 안 함(at-most-once).
  dispatch_started_at timestamptz,
  deadline_at timestamptz not null,
  fcm_accepted_at timestamptz,
  device_delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, team_id, event_type, token_id, token_hash)
);

create index if not exists idx_lineup_confirm_delivery_claim
  on lineup_confirm_delivery_ledger (game_id, team_id, status, next_attempt_at, lease_until, id);

alter table lineup_confirm_delivery_ledger enable row level security;
-- 정책 없음: service_role cron 전용.

-- ── snapshot: (game,team) 최초 1회 대상 디바이스 원장 생성 ──
create or replace function snapshot_lineup_confirm_deliveries(
  p_game_id text,
  p_team_id integer,
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
  insert into game_lineup_notify_state (game_id, team_id)
  values (p_game_id, p_team_id)
  on conflict (game_id, team_id) do nothing;

  update game_lineup_notify_state
     set lineup_snapshot_at = p_snapshot_at,
         lineup_snapshot_deadline_at = p_deadline_at,
         updated_at = now()
   where game_id = p_game_id
     and team_id = p_team_id
     and lineup_notified = false
     and lineup_snapshot_at is null;

  v_created := found;
  if not v_created then
    select lineup_snapshot_deadline_at
      into v_deadline
      from game_lineup_notify_state
     where game_id = p_game_id and team_id = p_team_id;
    return v_deadline;
  end if;

  insert into lineup_confirm_delivery_ledger (
    game_id, team_id, token_id, token_hash, user_id, platform, fcm_token, deadline_at
  )
  select
    p_game_id,
    p_team_id,
    d.id,
    encode(extensions.digest(d.fcm_token, 'sha256'), 'hex'),
    d.user_id,
    d.platform,
    d.fcm_token,
    p_deadline_at
  from device_push_tokens d
  join profiles p on p.id = d.user_id
  left join notification_prefs np on np.user_id = d.user_id
  where p.team_id = p_team_id
    and coalesce(np.lineup_confirm, true)
  on conflict (game_id, team_id, event_type, token_id, token_hash) do nothing;

  return p_deadline_at;
end;
$$;

-- ── claim: pending 우선, transient 재시도 1회, lease fencing ──
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
      and l.attempts < 2
      and l.fcm_token is not null
    order by case l.status when 'pending' then 0 when 'transient' then 1 else 2 end, l.id
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

-- ── mark dispatching: FCM 직전 durable intent(재claim 차단) ──
create or replace function mark_lineup_confirm_deliveries_dispatching(
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
  update lineup_confirm_delivery_ledger
     set dispatch_started_at = now(),
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

-- ── settle batch: FCM batch 결과를 단일 RPC로 원자 settle ──
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

-- ── finalize: deadline 경과 만료 + 전 행 terminal이면 lineup_notified=true 종결 ──
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
  select lineup_snapshot_deadline_at
    into v_deadline
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
  ),
  completed as (
    update game_lineup_notify_state
       set lineup_notified = true,
           updated_at = now()
     where game_id = p_game_id
       and team_id = p_team_id
       and lineup_snapshot_at is not null
       and (select counts.pending from counts) = 0
    returning true
  )
  select
    coalesce((select true from completed), false),
    counts.accepted,
    counts.pending,
    counts.permanent_failed,
    counts.expired
  from counts;
end;
$$;

revoke all on function snapshot_lineup_confirm_deliveries(text, integer, timestamptz, timestamptz) from anon, authenticated, public;
revoke all on function claim_lineup_confirm_deliveries(text, integer, uuid, integer, integer) from anon, authenticated, public;
revoke all on function mark_lineup_confirm_deliveries_dispatching(uuid[], uuid) from anon, authenticated, public;
revoke all on function settle_lineup_confirm_delivery_batch(jsonb, uuid) from anon, authenticated, public;
revoke all on function finalize_lineup_confirm_deliveries(text, integer) from anon, authenticated, public;
grant execute on function snapshot_lineup_confirm_deliveries(text, integer, timestamptz, timestamptz) to service_role;
grant execute on function claim_lineup_confirm_deliveries(text, integer, uuid, integer, integer) to service_role;
grant execute on function mark_lineup_confirm_deliveries_dispatching(uuid[], uuid) to service_role;
grant execute on function settle_lineup_confirm_delivery_batch(jsonb, uuid) to service_role;
grant execute on function finalize_lineup_confirm_deliveries(text, integer) to service_role;
