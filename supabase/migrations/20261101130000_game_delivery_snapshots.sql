-- One durable public-data snapshot per game/channel; not part of Realtime.
-- Apply before enabling GAME_SNAPSHOT_WRITE_ENABLED. Read switch is separate.
create table if not exists public.game_delivery_snapshots (
  game_id text not null check (game_id ~ '^[0-9]{8}[A-Z]{4}[0-9]$'),
  channel text not null check (channel in ('relay','events','live','detail')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 1000000),
  observed_at timestamptz not null,
  epoch bigint not null,
  ordinal bigint not null,
  final_seen_at timestamptz,
  archived_at timestamptz,
  primary key (game_id, channel)
);
alter table public.game_delivery_snapshots enable row level security;
revoke all on public.game_delivery_snapshots from public, anon, authenticated;
grant select, insert, update on public.game_delivery_snapshots to service_role;
create index if not exists game_delivery_snapshots_date_channel on public.game_delivery_snapshots
  (channel, game_id, observed_at desc);

create or replace function public.publish_game_delivery_snapshot(
  p_game_id text, p_channel text, p_payload jsonb, p_observed_at timestamptz,
  p_epoch bigint, p_ordinal bigint
) returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare changed integer;
begin
  if p_payload ? 'error' or p_payload->>'degraded' = 'true' or p_payload->>'partial' = 'true'
     or p_observed_at > now() + interval '30 seconds' then
    return false;
  end if;
  if p_channel = 'relay' and (jsonb_typeof(p_payload->'innings') is distinct from 'array'
      or jsonb_array_length(p_payload->'innings') = 0) then return false; end if;
  if p_channel = 'detail' and p_payload->>'status' = 'final' and
      (jsonb_typeof(p_payload->'linescore') is distinct from 'object' or
       jsonb_typeof(p_payload->'boxScore') is distinct from 'object') then return false; end if;
  if p_channel = 'live' then
    if not exists (select 1 from jsonb_array_elements(p_payload->'games') g where g->>'gameId' = p_game_id) then
      return false;
    end if;
  elsif p_channel = 'events' then
    if jsonb_typeof(p_payload->'events') is distinct from 'array' or p_payload->'currentState' is null
       or p_payload->'currentState' = 'null'::jsonb then return false; end if;
    if exists (select 1 from jsonb_array_elements(p_payload->'events') e where e->>'gameId' is distinct from p_game_id) then return false; end if;
  elsif p_channel in ('relay','detail') and p_payload->>'gameId' is distinct from p_game_id then
    return false;
  end if;
  insert into public.game_delivery_snapshots as target
    (game_id, channel, payload, observed_at, epoch, ordinal, final_seen_at)
  values (p_game_id, p_channel, p_payload, p_observed_at, p_epoch, p_ordinal,
    case when p_channel = 'detail' and p_payload->>'status' = 'final' then now() end)
  on conflict (game_id, channel) do update set
    payload = excluded.payload, observed_at = excluded.observed_at,
    epoch = excluded.epoch, ordinal = excluded.ordinal, archived_at = null,
    final_seen_at = case when excluded.payload->>'status' = 'final'
      then coalesce(target.final_seen_at, excluded.final_seen_at) else null end
  where (excluded.epoch, excluded.ordinal) > (target.epoch, target.ordinal)
    and excluded.observed_at >= target.observed_at;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;
revoke all on function public.publish_game_delivery_snapshot(text,text,jsonb,timestamptz,bigint,bigint) from public, anon, authenticated;
grant execute on function public.publish_game_delivery_snapshot(text,text,jsonb,timestamptz,bigint,bigint) to service_role;

-- A stable official final result plus all four post-final observations are required.
-- The archive is independent of the 24-hour Realtime frame/cache retention.
create or replace function public.archive_game_delivery_snapshot(p_game_id text)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare final_time timestamptz; final_payload jsonb; relay_payload jsonb; events_payload jsonb; live_payload jsonb;
begin
  -- Serialize with other archive attempts, and lock all existing channels against writers.
  perform 1 from public.game_delivery_snapshots where game_id = p_game_id order by channel for update;
  if exists (select 1 from public.game_delivery_snapshots where game_id = p_game_id and channel = 'detail' and archived_at is not null) then return true; end if;
  select final_seen_at into final_time from public.game_delivery_snapshots
    where game_id = p_game_id and channel = 'detail' and payload->>'status' = 'final';
  if final_time is null or final_time > now() - interval '10 minutes' then return false; end if;
  if (select count(*) from public.game_delivery_snapshots where game_id = p_game_id
      and observed_at >= final_time + interval '10 minutes') <> 4 then return false; end if;
  select payload into final_payload from public.game_delivery_snapshots where game_id=p_game_id and channel='detail';
  select payload into relay_payload from public.game_delivery_snapshots where game_id=p_game_id and channel='relay';
  select payload into events_payload from public.game_delivery_snapshots where game_id=p_game_id and channel='events';
  select g into live_payload from public.game_delivery_snapshots s, jsonb_array_elements(s.payload->'games') g
    where s.game_id=p_game_id and s.channel='live' and g->>'gameId'=p_game_id limit 1;
  if live_payload->>'status' is distinct from 'final' or
     final_payload#>>'{linescore,away,R}' is null or final_payload#>>'{linescore,home,R}' is null or
     relay_payload#>>'{linescore,away,R}' is distinct from final_payload#>>'{linescore,away,R}' or
     relay_payload#>>'{linescore,home,R}' is distinct from final_payload#>>'{linescore,home,R}' or
     events_payload#>>'{currentState,awayScore}' is distinct from final_payload#>>'{linescore,away,R}' or
     events_payload#>>'{currentState,homeScore}' is distinct from final_payload#>>'{linescore,home,R}' or
     live_payload->>'awayScore' is distinct from final_payload#>>'{linescore,away,R}' or
     live_payload->>'homeScore' is distinct from final_payload#>>'{linescore,home,R}' then return false; end if;
  update public.game_delivery_snapshots set archived_at = now() where game_id = p_game_id;
  return true;
end;
$$;
revoke all on function public.archive_game_delivery_snapshot(text) from public, anon, authenticated;
grant execute on function public.archive_game_delivery_snapshot(text) to service_role;
