-- Live Activity channel_born 자동 reconcile/self-heal.
--
-- 서버 p2s 성공 뒤 best-effort 마킹이 시간예산/DB 오류로 소실돼도, 단말이 현재 active
-- 채널을 실제 ACK한 강한 증거가 있으면 매분 warmup이 이 RPC로 장부를 회수한다.
--
-- 불변식:
-- ① 현재 active (game, environment, channel_id)와 정확 일치하는 ACK만 증거로 인정.
-- ② channel_born_channel_id IS NULL인 행만 갱신 — 이미 마킹된 행은 절대 덮지 않음.
-- ③ active 행을 SHARE lock한 같은 statement에서 후보선정+UPDATE — 동시 채널 회전은
--    직렬화되어, 회전 후 구채널 ACK를 새 마킹으로 기록하는 race 차단.
-- ④ 실행당 최대 1,000(서버 입력도 1,000 cap), SQL 5초 timeout — 다음 분이 이어서 수렴.

create or replace function public.reconcile_live_activity_channel_born(
  p_limit integer default 1000
)
returns table (
  active_generations integer,
  eligible integer,
  healed integer,
  has_more boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  v_active_count integer;
begin
  perform set_config('statement_timeout', '5000', true);

  select count(*)::integer
    into v_active_count
    from public.live_activity_channels
   where status = 'active';

  -- KBO 하루 최대 10경기×2환경보다 충분한 상한. lifecycle 이상으로 active가 누적되면
  -- 일부만 조용히 처리하지 않고 실패로 드러내 운영자가 원인을 보게 한다.
  if v_active_count > 32 then
    raise exception 'active live activity channel generations exceed bound: %', v_active_count;
  end if;

  return query
  with active as materialized (
    select c.game_id, c.environment, c.channel_id
      from public.live_activity_channels c
     where c.status = 'active'
     order by c.game_id, c.environment
     for share
  ),
  candidates as materialized (
    select distinct on (s.game_id, s.user_id)
           s.game_id,
           s.user_id,
           a.environment,
           a.channel_id
      from public.live_activity_started_users s
      join active a
        on a.game_id = s.game_id
      join public.live_activity_channel_subscriptions ack
        on ack.game_id = s.game_id
       and ack.user_id = s.user_id
       and ack.environment = a.environment
       and ack.channel_id = a.channel_id
     where s.channel_born_channel_id is null
     order by
       s.game_id,
       s.user_id,
       (a.environment = 'production') desc,
       a.environment,
       a.channel_id
     limit (v_limit + 1)
  ),
  selected as materialized (
    select *
      from candidates
     order by game_id, user_id
     limit v_limit
  ),
  updated as (
    update public.live_activity_started_users s
       set channel_born_environment = selected.environment,
           channel_born_channel_id = selected.channel_id
      from selected
     where s.game_id = selected.game_id
       and s.user_id = selected.user_id
       and s.channel_born_channel_id is null
    returning s.game_id
  )
  select
    v_active_count,
    (select count(*)::integer from selected),
    (select count(*)::integer from updated),
    (select count(*) > v_limit from candidates);
end;
$$;

revoke all on function public.reconcile_live_activity_channel_born(integer) from public;
grant execute on function public.reconcile_live_activity_channel_born(integer) to service_role;
