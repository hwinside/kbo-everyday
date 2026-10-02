alter table public.live_activity_channels
  add column recovery_observed_at timestamptz,
  add column recovery_game_state jsonb;

alter table public.live_activity_start_tokens add column recovery_protocol integer;

-- Device/generation restart ledger. Never reset ACK/restart history on re-registration.
create table public.live_activity_device_recovery (
  game_id text not null,
  device_key text not null,
  environment text not null check (environment in ('production','sandbox')),
  channel_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  initial_at timestamptz,
  ack_at timestamptz,
  challenge uuid,
  challenge_at timestamptz,
  restart_at timestamptz,
  attributes jsonb,
  primary key (game_id, device_key, environment, channel_id)
);
alter table public.live_activity_device_recovery enable row level security;
revoke all on public.live_activity_device_recovery from anon, authenticated;

-- One RPC owns ACK, initial acceptance, challenge and claim. The row lock serializes
-- ACK vs restart; a claim wins at most once even with duplicate/concurrent reports.
-- p_token is a protected server/device credential, never returned or logged.
create or replace function public.live_activity_recovery_step(
  p_action text, p_token text, p_environment text, p_game text default null,
  p_channel text default null, p_challenge uuid default null, p_attributes jsonb default null
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_owner uuid;
  v_device text;
  v_row public.live_activity_device_recovery%rowtype;
  v_channel public.live_activity_channels%rowtype;
  v_now timestamptz := clock_timestamp();
  v_content jsonb;
  v_result jsonb := '[]'::jsonb;
begin
  if p_environment not in ('production','sandbox') then return '{}'::jsonb; end if;
  select user_id into v_owner from public.live_activity_start_tokens
    where push_to_start_token = p_token and (p_action = 'ack' or os_major >= 18);
  if v_owner is null then return '{}'::jsonb; end if;
  v_device := encode(digest(p_token, 'sha256'), 'hex');

  if p_action = 'challenges' then
    update public.live_activity_start_tokens set recovery_protocol=1 where push_to_start_token=p_token;
    -- No-card must be observed AFTER this server challenge, not cached across wakes.
    for v_row in select r.* from public.live_activity_device_recovery r
      join public.live_activity_channels c on c.game_id=r.game_id and c.environment=r.environment
        and c.channel_id=r.channel_id and c.status='active'
      where r.device_key=v_device and r.user_id=v_owner and r.environment=p_environment
        and r.initial_at <= v_now - interval '2 minutes'
        and r.initial_at > v_now - interval '90 minutes'
        and r.ack_at is null and r.restart_at is null
      order by r.initial_at desc limit 10 for update of r
    loop
      -- An unexpired challenge is stable across overlapping native wake calls.
      update public.live_activity_device_recovery set
        challenge = case when challenge_at > v_now - interval '30 seconds' then challenge else gen_random_uuid() end,
        challenge_at = case when challenge_at > v_now - interval '30 seconds' then challenge_at else v_now end
        where game_id=v_row.game_id and device_key=v_device and environment=p_environment and channel_id=v_row.channel_id
        returning * into v_row;
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'gameId',v_row.game_id,'channelId',v_row.channel_id,'challenge',v_row.challenge));
    end loop;
    return jsonb_build_object('challenges',v_result);
  end if;

  select * into v_channel from public.live_activity_channels
    where game_id=p_game and environment=p_environment and channel_id=p_channel and status='active'
    for share;
  if not found then return '{}'::jsonb; end if;
  if p_action in ('initial','ack') then
    insert into public.live_activity_device_recovery(game_id,device_key,environment,channel_id,user_id)
      values(p_game,v_device,p_environment,p_channel,v_owner) on conflict do nothing;
  end if;
  select * into v_row from public.live_activity_device_recovery
    where game_id=p_game and device_key=v_device and environment=p_environment and channel_id=p_channel for update;
  if not found or v_row.user_id <> v_owner then return '{}'::jsonb; end if;

  if p_action = 'initial' then
    update public.live_activity_device_recovery set initial_at=coalesce(initial_at,v_now),
      attributes=coalesce(attributes,p_attributes)
      where game_id=p_game and device_key=v_device and environment=p_environment and channel_id=p_channel;
    return jsonb_build_object('recorded',true);
  elsif p_action = 'ack' then
    update public.live_activity_device_recovery set ack_at=coalesce(ack_at,v_now)
      where game_id=p_game and device_key=v_device and environment=p_environment and channel_id=p_channel;
    insert into public.live_activity_channel_subscriptions(game_id,device_key,environment,channel_id,user_id,confirmed_at)
      values(p_game,v_device,p_environment,p_channel,v_owner,v_now)
      on conflict(game_id,device_key,environment) do update set
        channel_id=excluded.channel_id,user_id=excluded.user_id,confirmed_at=excluded.confirmed_at;
    return jsonb_build_object('recorded',true);
  elsif p_action = 'claim' then
    v_content := case when v_channel.recovery_game_state->>'status' = 'scheduled'
      then v_channel.recovery_game_state else v_channel.last_content_state end;
    -- Fail closed: no initial exact-device evidence, stale report/payload, ACK (including
    -- pre-migration subscriptions), prior restart, opt-out or ended game => no send.
    if v_row.initial_at is null or v_row.initial_at > v_now - interval '2 minutes'
      or v_row.initial_at <= v_now - interval '90 minutes'
      or v_row.ack_at is not null or v_row.restart_at is not null
      or p_challenge is null or v_row.challenge is distinct from p_challenge
      or v_row.challenge_at is null or v_row.challenge_at <= v_now - interval '30 seconds'
      or v_channel.recovery_observed_at is null or v_channel.recovery_observed_at <= v_now - interval '3 minutes'
      or coalesce(v_channel.recovery_game_state->>'status','') not in ('scheduled','live')
      or coalesce(v_content->>'status','') not in ('scheduled','live')
      or v_row.attributes is null
      or exists(select 1 from public.notification_prefs where user_id=v_owner and live_activity=false)
      or exists(select 1 from public.live_activity_channel_subscriptions where game_id=p_game
        and device_key=v_device and environment=p_environment and channel_id=p_channel)
    then return '{}'::jsonb; end if;
    update public.live_activity_device_recovery set restart_at=v_now
      where game_id=p_game and device_key=v_device and environment=p_environment and channel_id=p_channel
        and restart_at is null;
    if not found then return '{}'::jsonb; end if;
    return jsonb_build_object('claimed',true,'attributes',v_row.attributes,
      'contentState',v_content,'attempt',p_challenge,'channelId',p_channel);
  end if;
  return '{}'::jsonb;
end $$;
revoke all on function public.live_activity_recovery_step(text,text,text,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.live_activity_recovery_step(text,text,text,text,text,uuid,jsonb) to service_role;
