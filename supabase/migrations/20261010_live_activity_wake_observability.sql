-- Server receipts are not device delivery/visible-card evidence. No recovery writes.
create table public.live_activity_wake_receipts (
  invocation_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  game_id text not null,
  fcm_token_hash text not null check (fcm_token_hash ~ '^[a-f0-9]{64}$'),
  attempted_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  outcome text not null check (outcome in ('accepted','rejected','unknown')),
  error_code text,
  primary key (invocation_id, user_id, game_id, fcm_token_hash)
);
create index on public.live_activity_wake_receipts(user_id, attempted_at desc);
alter table public.live_activity_wake_receipts enable row level security;
revoke all on public.live_activity_wake_receipts from public, anon, authenticated;
grant all on public.live_activity_wake_receipts to service_role;

-- Separate ledger preserves unmatched token/environment requests too.
-- Only syntactically valid protocol-1 challenges requests are covered.
create table public.live_activity_challenges_requests (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  device_key text not null check (device_key ~ '^[a-f0-9]{64}$'),
  environment text not null check (environment in ('production','sandbox')),
  user_id uuid references auth.users(id) on delete cascade,
  owner_matched boolean not null,
  issued_count integer check (issued_count between 0 and 10),
  rpc_failed boolean not null,
  -- Post-request snapshot, NOT an atomic explanation of the earlier RPC decision.
  snapshot_reasons jsonb not null,
  check ((rpc_failed and issued_count is null) or (not rpc_failed and issued_count is not null))
);
create index on public.live_activity_challenges_requests(device_key, received_at desc);
create index on public.live_activity_challenges_requests(user_id, received_at desc);
alter table public.live_activity_challenges_requests enable row level security;
revoke all on public.live_activity_challenges_requests from public, anon, authenticated;
grant all on public.live_activity_challenges_requests to service_role;

-- Bound the diagnostic lookup to this token, not all devices.
create index if not exists live_activity_device_recovery_device_observation_idx
  on public.live_activity_device_recovery(device_key);

create function public.record_live_activity_challenges_request(
  p_token text, p_environment text, p_received_at timestamptz,
  p_issued_count integer, p_rpc_failed boolean
) returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_owner uuid;
  v_os integer;
  v_device text := encode(digest(p_token, 'sha256'), 'hex');
  v_now timestamptz := clock_timestamp();
  v_reasons jsonb;
begin
  select user_id, os_major into v_owner, v_os from public.live_activity_start_tokens
    where push_to_start_token = p_token;
  select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb) into v_reasons from (
    select reason, count(*) n from (
      select case
        when r.environment <> p_environment then 'environment_mismatch'
        when r.user_id <> v_owner then 'owner_mismatch'
        when r.ack_at is not null then 'already_acked'
        when r.restart_at is not null then 'already_restarted'
        when r.initial_at is null then 'no_initial'
        when r.initial_at > v_now - interval '2 minutes' then 'too_early'
        when r.initial_at <= v_now - interval '90 minutes' then 'expired'
        when not exists (select 1 from public.live_activity_channels c
          where c.game_id=r.game_id and c.environment=r.environment
          and c.channel_id=r.channel_id and c.status='active') then 'inactive_channel'
        else 'eligible' end reason
      from public.live_activity_device_recovery r where r.device_key=v_device
    ) classified group by reason
  ) counts;
  if v_owner is null then v_reasons := jsonb_build_object('token_unmatched', 1);
  elsif v_os is null or v_os < 18 then v_reasons := jsonb_build_object('unsupported_os', 1);
  elsif v_reasons = '{}'::jsonb then v_reasons := jsonb_build_object('no_recovery_rows', 1);
  end if;
  insert into public.live_activity_challenges_requests(
    received_at, device_key, environment, user_id, owner_matched, issued_count, rpc_failed, snapshot_reasons
  ) values (p_received_at,v_device,p_environment,v_owner,v_owner is not null,p_issued_count,p_rpc_failed,v_reasons);
end $$;
revoke all on function public.record_live_activity_challenges_request(text,text,timestamptz,integer,boolean) from public, anon, authenticated;
grant execute on function public.record_live_activity_challenges_request(text,text,timestamptz,integer,boolean) to service_role;
