-- 경기 시작알림 non-Vercel watchdog.
-- Supabase pg_cron이 15초마다 production의 전용 얇은 route를 호출한다.
-- secret/url 값은 repo에 두지 않고 운영자가 private config에 선적용한다.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

create schema if not exists private;

create table if not exists private.game_start_watchdog_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  url text not null,
  secret text not null,
  active_start_kst time not null default time '12:00',
  active_end_kst time not null default time '01:00',
  updated_at timestamptz not null default now()
);

revoke all on schema private from anon, authenticated, public;
revoke all on private.game_start_watchdog_config from anon, authenticated, public;

create or replace function private.invoke_game_start_watchdog()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, net, private
as $$
declare
  cfg private.game_start_watchdog_config%rowtype;
  now_kst time := (clock_timestamp() at time zone 'Asia/Seoul')::time;
  in_window boolean;
begin
  select * into cfg
    from private.game_start_watchdog_config
   where id = true
     and enabled = true;
  if not found then
    return null;
  end if;

  in_window := case
    when cfg.active_start_kst <= cfg.active_end_kst
      then now_kst >= cfg.active_start_kst and now_kst < cfg.active_end_kst
    else now_kst >= cfg.active_start_kst or now_kst < cfg.active_end_kst
  end;
  if not in_window then
    return null;
  end if;

  return net.http_post(
    url := cfg.url,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cfg.secret
    ),
    timeout_milliseconds := 14000
  );
end;
$$;

revoke all on function private.invoke_game_start_watchdog() from anon, authenticated, public;

do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job
    from cron.job
   where jobname = 'game-start-watchdog-15s';
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
  perform cron.schedule(
    'game-start-watchdog-15s',
    '15 seconds',
    'select private.invoke_game_start_watchdog()'
  );
end;
$$;

-- 운영 선적용(값은 secret store에서 주입):
-- insert into private.game_start_watchdog_config (id, enabled, url, secret)
-- values (true, true, 'https://keubo.fan/api/cron/game-start-watchdog', '<CRON_SECRET>')
-- on conflict (id) do update
-- set enabled = excluded.enabled, url = excluded.url, secret = excluded.secret, updated_at = now();
