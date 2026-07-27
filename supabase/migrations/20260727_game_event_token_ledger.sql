-- S2 Slice0 (삼순 2차 NO-GO #1/#2) — score/concede/inning-summary 이벤트의 durable token 원장.
--
-- 배경: score-family는 지금까지 event-global claim(notified_score_events, event_id PK) 하나로
-- 재발송을 가늠했다. 한 이벤트에 A 토큰 accepted·B 토큰 transient면 event-global claim이
-- 통째로 해제돼 다음 tick에 A+B 전량 재발송된다 — prod iOS/구Android는 native dedup이 없어
-- 즉시 중복 배너가 뜬다(NO-GO #1). 또 notification 버킷 accepted 뒤 data-only 버킷 전송 중
-- crash 시 checkpoint가 없어 재실행이 첫 버킷을 재타격한다(NO-GO #2 bucket checkpoint).
--
-- closure: game_start_delivery_ledger / notified_player_highlight_tokens와 동일한 검증된
-- "token별 accepted/permanent settle + transient/미시도만 재claim" 원장을 score-family로 복제한다
-- (start barrier 없음, audience = 팀팬 1집합). event-global notified_score_events claim은 marker로
-- 유지하되(claim RPC가 snapshot finalize 시 함께 기록), 재발송 판정은 이 token 원장 상태로만 한다.
--
-- 불변식
-- 1) 한 이벤트의 audience(팀팬 스냅샷)는 최초 claim 1회에 freeze한다. 이후 팬 추가는 catch-up 안 한다.
-- 2) (event_id, token_id, token_hash)가 멱등 키. 같은 id 토큰 교체도 다른 hash로 구분.
-- 3) lease_token fencing을 통과한 worker만 결과를 settle한다.
-- 4) transient/미시도 토큰만 deadline(source_ts + 6h = n_expires_at) 안에서 재claim. accepted/permanent 재발송 0.
-- 5) 버킷(notification/data-only)은 각각 send 직후 settle → 버킷 간 crash가 앞 버킷 accepted를 재타격하지 않음.

create extension if not exists pgcrypto with schema extensions;

-- 이벤트별 frozen payload + audience freeze 마커. source 소멸(경기 final) 뒤에도 due-drain이
-- 이 snapshot으로 transient 토큰을 계속 drain한다. deadline_at = source 시각 + 6h(= n_expires_at).
create table if not exists game_event_delivery_snapshots (
  event_id text primary key,
  game_id text not null,
  sub text not null check (sub in ('score', 'concede', 'inning-summary')),
  pref_key text not null
    check (pref_key in ('my_team_score', 'my_team_concede', 'my_team_score_inning_summary')),
  team_id integer not null,
  push_title text not null,
  push_body text not null,
  push_url text not null,
  -- source event timestamp(불변 앵커). null이면 파싱 불가 → notification-only(fail-closed, n_expires_at 미첨부).
  source_ts timestamptz,
  snapshot_completed boolean not null default false,
  deadline_at timestamptz not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table game_event_delivery_snapshots enable row level security;
-- 정책 없음: service_role cron 전용.

create table if not exists notified_game_event_tokens (
  event_id text not null,
  game_id text not null,
  sub text not null,
  token_id bigint not null,
  token_hash text not null,
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

create index if not exists idx_game_event_token_claim
  on notified_game_event_tokens (event_id, status, next_attempt_at, lease_until, token_id);

alter table notified_game_event_tokens enable row level security;

-- ledger activation/cutover 경계(삼순 4차 NO-GO #1). 시간 freshness heuristic 대신 "이 원장이
-- 언제부터 이벤트를 소유하는가"를 명시한다. 단일행(id=true) — claim RPC 최초 호출이 activated_at을
-- now()로 자가부트스트랩한다. migration 적용 시각이 아닌 신 코드 최초 진입 시각이 경계가 되어
-- (migration 선적용~코드 배포 사이 구 코드가 만든 marker는 activation 이전이므로 legacy로 판정) cutover
-- 재발송 창을 닫는다.
create table if not exists game_event_ledger_activation (
  id boolean primary key default true,
  activated_at timestamptz not null default now(),
  constraint game_event_ledger_activation_singleton check (id)
);

alter table game_event_ledger_activation enable row level security;
-- 정책 없음: service_role cron 전용.

-- 이벤트 audience를 원장에 freeze하고(최초 1회) claimable 토큰 배치를 lease해 돌려준다.
-- 최초 호출(=snapshot 생성자)만 팀팬을 열거해 token 행을 만든다. 이후 호출/다중 인스턴스는
-- on-conflict-nothing으로 no-op이고 claimable 토큰만 skip-locked로 나눠 lease한다.
create or replace function claim_game_event_tokens(
  p_event_id text,
  p_game_id text,
  p_sub text,
  p_team_id integer,
  p_pref_key text,
  p_push_title text,
  p_push_body text,
  p_push_url text,
  p_source_ts timestamptz,
  p_lease_token uuid,
  p_lease_seconds integer default 20,
  p_limit integer default 500
)
returns table (
  token_id bigint,
  token_hash text,
  fcm_token text,
  platform text,
  app_build integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_created boolean;
  v_activation timestamptz;
  v_has_snapshot boolean;
  v_marker_created timestamptz;
  v_deadline timestamptz := coalesce(p_source_ts, now()) + interval '6 hours';
begin
  if p_pref_key not in ('my_team_score', 'my_team_concede', 'my_team_score_inning_summary') then
    raise exception 'invalid game_event preference';
  end if;
  if p_sub not in ('score', 'concede', 'inning-summary') then
    raise exception 'invalid game_event sub';
  end if;

  -- activation 경계 자가부트스트랩(멱둥): 이 원장을 처음 호출하는 신 코드가 경계를 고정한다.
  -- 그 이전에 구 코드(claimEvent)가 만든 marker는 전부 activated_at 이전이라 legacy로 분류된다.
  insert into game_event_ledger_activation (id) values (true) on conflict (id) do nothing;
  select activated_at into v_activation from game_event_ledger_activation where id;

  -- ledger-상태 기반 진입 gate(시간 freshness heuristic 폐기, 삼순 4차 NO-GO #1).
  -- snapshot이 이미 있으면 원장이 이미 이 이벤트를 소유한 것이니 그대로 재개(claim)한다.
  v_has_snapshot := exists (select 1 from game_event_delivery_snapshots where event_id = p_event_id);
  if not v_has_snapshot then
    -- snapshot 없음: 원장 진입(snapshot 생성) 여부를 marker/source vs activation으로 판정.
    select created_at into v_marker_created from notified_score_events where event_id = p_event_id;
    if found then
      -- marker는 있고 snapshot은 없다.
      if v_marker_created < v_activation then
        -- pre-cutover legacy marker: 구 코드가 이미 발송함 → 신규 원장 재발송 0. snapshot 생성 안 함.
        return;
      end if;
      -- else: post-activation marker-only orphan → source age 무관하게 아래서 snapshot 생성(복구).
    else
      -- marker도 snapshot도 없음: 진짜 신규(source_ts ≥ activation)만 원장 진입. activation 이전 source는
      -- 배포-시 과거분 backlog이므로 skip(일괄 발송 방지). source_ts null(fail-closed)은 진입 허용.
      if p_source_ts is not null and p_source_ts < v_activation then
        return;
      end if;
    end if;
  end if;

  -- audience는 즉시 freeze(완료)한다 — score-family는 start barrier가 없고 팬 집합이 지금 확정이다.
  insert into game_event_delivery_snapshots (
    event_id, game_id, sub, pref_key, team_id,
    push_title, push_body, push_url, source_ts,
    snapshot_completed, deadline_at, completed_at
  )
  values (
    p_event_id, p_game_id, p_sub, p_pref_key, p_team_id,
    p_push_title, p_push_body, p_push_url, p_source_ts,
    true, v_deadline, now()
  )
  on conflict (event_id) do nothing;

  v_created := found;

  if v_created then
    -- 이 호출이 snapshot을 만든 유일한 worker → 팀팬 audience를 token 원장에 freeze.
    -- pref 디폴트는 prefs.ts DEFAULT_PREFS와 일치(score=on, concede/inning-summary=off).
    insert into notified_game_event_tokens (
      event_id, game_id, sub, token_id, token_hash
    )
    select
      p_event_id,
      p_game_id,
      p_sub,
      d.id,
      encode(extensions.digest(d.fcm_token, 'sha256'), 'hex')
    from device_push_tokens d
    join profiles p on p.id = d.user_id
    left join notification_prefs np on np.user_id = d.user_id
    where p.team_id = p_team_id
      and case p_pref_key
        when 'my_team_score' then coalesce(np.my_team_score, true)
        when 'my_team_concede' then coalesce(np.my_team_concede, false)
        when 'my_team_score_inning_summary' then coalesce(np.my_team_score_inning_summary, false)
        else false
      end
    on conflict on constraint notified_game_event_tokens_pkey do nothing;

    -- event-global marker 유지(재발송 판정은 token 원장이 하고, 이 행은 back-compat/관측용).
    insert into notified_score_events (event_id, game_id)
    values (p_event_id, p_game_id)
    on conflict (event_id) do nothing;
  end if;

  -- deadline(= source_ts + 6h = n_expires_at) 지난 미종결 토큰은 명시 expired로 닫는다.
  update notified_game_event_tokens n
     set status = 'expired',
         lease_token = null,
         lease_until = null,
         last_error = coalesce(n.last_error, 'game_event_deadline_exceeded'),
         updated_at = now()
    from game_event_delivery_snapshots s
   where n.event_id = p_event_id
     and s.event_id = n.event_id
     and s.deadline_at <= now()
     and n.status in ('waiting', 'leased', 'transient');

  return query
  with eligible as (
    select n.token_id, n.token_hash, d.fcm_token, d.platform, d.app_build
    from notified_game_event_tokens n
    join device_push_tokens d
      on d.id = n.token_id
     and encode(extensions.digest(d.fcm_token, 'sha256'), 'hex') = n.token_hash
    where n.event_id = p_event_id
      and (
        n.status in ('waiting', 'transient')
        or (n.status = 'leased' and n.lease_until < now())
      )
      and n.next_attempt_at <= now()
      and exists (
        select 1 from game_event_delivery_snapshots s
        where s.event_id = n.event_id
          and s.deadline_at > now()
      )
    -- 최초 미시도 전량이 transient retry에 굶지 않게 waiting을 먼저 drain한다.
    order by case n.status when 'waiting' then 0 when 'transient' then 1 else 2 end, n.token_id
    for update of n skip locked
    limit greatest(1, least(p_limit, 500))
  ),
  claimed as (
    update notified_game_event_tokens n
       set status = 'leased',
           attempts = n.attempts + 1,
           lease_token = p_lease_token,
           lease_until = now() + make_interval(secs => greatest(1, p_lease_seconds)),
           updated_at = now()
      from eligible e
     where n.event_id = p_event_id
       and n.token_id = e.token_id
       and n.token_hash = e.token_hash
    returning n.token_id, n.token_hash
  )
  select e.token_id, e.token_hash, e.fcm_token, e.platform, e.app_build
  from eligible e
  join claimed c using (token_id, token_hash);
end;
$$;

-- 한 claim 배치(같은 lease_token)의 버킷 결과를 token별 durable 상태로 settle한다.
-- 버킷별로 각각 호출한다(notification settle → data-only settle) → 버킷 checkpoint(NO-GO #2).
create or replace function settle_game_event_tokens(
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
      (r->>'token_id')::bigint as token_id,
      r->>'token_hash' as token_hash,
      r->>'status' as status,
      nullif(r->>'error', '') as error
    from jsonb_array_elements(p_results) r
    where r->>'status' in ('accepted', 'transient', 'permanent_failed')
  ),
  settled as (
    update notified_game_event_tokens n
       set status = i.status,
           accepted_at = case when i.status = 'accepted' then now() else n.accepted_at end,
           last_error = i.error,
           next_attempt_at = case
             when i.status = 'transient' then now() + interval '30 seconds'
             else n.next_attempt_at
           end,
           lease_token = null,
           lease_until = null,
           updated_at = now()
      from result_rows i
     where n.token_id = i.token_id
       and n.token_hash = i.token_hash
       and n.status = 'leased'
       and n.lease_token = p_lease_token
    returning n.status
  )
  select count(*) filter (where status = 'accepted')
    into v_accepted
    from settled;
  return coalesce(v_accepted, 0);
end;
$$;

-- source(경기 feed) 소멸 뒤에도 재개할 due snapshot 목록: deadline 안이고 non-terminal 토큰이 남은 것.
create or replace function list_due_game_event_snapshots(
  p_limit integer default 50
)
returns table (
  event_id text,
  game_id text,
  sub text,
  pref_key text,
  team_id integer,
  push_title text,
  push_body text,
  push_url text,
  source_ts timestamptz
)
language sql
security definer
set search_path = public
as $$
  select s.event_id, s.game_id, s.sub, s.pref_key, s.team_id,
         s.push_title, s.push_body, s.push_url, s.source_ts
  from game_event_delivery_snapshots s
  where s.deadline_at > now()
    and exists (
      select 1 from notified_game_event_tokens n
      where n.event_id = s.event_id
        and (
          n.status in ('waiting', 'transient')
          or (n.status = 'leased' and n.lease_until < now())
        )
        and n.next_attempt_at <= now()
    )
  order by s.created_at
  limit greatest(1, least(p_limit, 200));
$$;

revoke all on function claim_game_event_tokens(text, text, text, integer, text, text, text, text, timestamptz, uuid, integer, integer) from anon, authenticated, public;
revoke all on function settle_game_event_tokens(jsonb, uuid) from anon, authenticated, public;
revoke all on function list_due_game_event_snapshots(integer) from anon, authenticated, public;
grant execute on function claim_game_event_tokens(text, text, text, integer, text, text, text, text, timestamptz, uuid, integer, integer) to service_role;
grant execute on function settle_game_event_tokens(jsonb, uuid) to service_role;
grant execute on function list_due_game_event_snapshots(integer) to service_role;
