-- Live Activity channel_born 자동 reconcile/self-heal.
--
-- 서버 p2s 성공 뒤 best-effort 마킹이 시간예산/DB 오류로 소실돼도, 단말이 현재 active
-- 채널을 실제 ACK한 강한 증거가 있으면 매분 warmup이 이 RPC로 장부를 회수한다.
--
-- 불변식:
-- ① 현재 active (game, environment, channel_id)와 정확 일치하는 ACK만 증거로 인정.
-- ② channel_born_channel_id IS NULL인 행만 갱신 — 이미 마킹된 행은 절대 덮지 않음.
-- ③ active 행을 SHARE lock한 뒤 후보선정+UPDATE — 동시 채널 회전 중이면 그 active 행은
--    SKIP LOCKED로 건너뛰어(그 경기만 이번 tick 제외) 회전 후 구채널 ACK를 새 마킹으로
--    기록하는 race를 차단한다. 회전이 commit된 다음 tick이 정상 마킹한다.
--
-- 유계 보장 (삼순 R1 blocker — statement_timeout 자기-arm 불가 대체):
--   plpgsql 함수 body의 `set statement_timeout`은 이미 시작된 outer 문(=이 RPC 호출)의
--   타이머를 재-arm하지 못한다(PG17 실증). 그래서 시간제한에 의존하지 않고 구조적으로
--   유계로 만든다:
--     · 실행당 후보/갱신 ≤ v_limit(≤1,000) — 인덱스 기반 select/update, 상한 고정.
--     · 모든 lock 획득에 SKIP LOCKED — active 채널(FOR SHARE)·대상 started_users
--       (FOR UPDATE) 어디서도 concurrent locker를 "대기"하지 않는다. 잠긴 행은 즉시
--       건너뛰고 다음 tick이 이어서 수렴한다. 따라서 lock 경합이 있어도 이 RPC는
--       무한/장시간 블록 없이 유계 시간에 반환한다.
--   클라이언트 AbortSignal(5초)은 방어적 상한일 뿐, DB backend 종료 보장은 위 구조가 진다.

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
    -- 회전 중(FOR UPDATE 보유)인 active 행은 건너뛴다 — 대기 대신 다음 tick 위임.
    select c.game_id, c.environment, c.channel_id
      from public.live_activity_channels c
     where c.status = 'active'
     order by c.game_id, c.environment
     for share skip locked
  ),
  -- 잠금(SKIP LOCKED)을 batch LIMIT '이전'에 적용한다(삼순 R2). started_users를 직접
  -- 스캔하며 잠긴 행을 건너뛰고 unlocked 후보로 배치를 채우므로, 앞 v_limit개가 잠겨
  -- 있어도 그 뒤 unlocked 정상 행이 같은 tick에 heal된다(배치 경계 starvation 차단).
  -- 자격 = '현재 active (env,channel)과 정확 일치하는 ACK 존재'(stale/구채널 ACK 제외).
  -- started_users PK가 (game,user)라 s는 (game,user)당 1행 → 여기샠 distinct 불필요.
  locked as materialized (
    select s.game_id, s.user_id
      from public.live_activity_started_users s
     where s.channel_born_channel_id is null
       and exists (
         select 1
           from active a
           join public.live_activity_channel_subscriptions ack
             on ack.game_id = s.game_id
            and ack.user_id = s.user_id
            and ack.environment = a.environment
            and ack.channel_id = a.channel_id
          where a.game_id = s.game_id
       )
     order by s.game_id, s.user_id
     for update of s skip locked
     limit (v_limit + 1)
  ),
  -- 잠근 대상 행에 대해서만 기록할 (env,channel) 결정 — 복수 ACK면 production 우선.
  resolved as materialized (
    select distinct on (l.game_id, l.user_id)
           l.game_id,
           l.user_id,
           a.environment,
           a.channel_id
      from locked l
      join active a
        on a.game_id = l.game_id
      join public.live_activity_channel_subscriptions ack
        on ack.game_id = l.game_id
       and ack.user_id = l.user_id
       and ack.environment = a.environment
       and ack.channel_id = a.channel_id
     order by
       l.game_id,
       l.user_id,
       (a.environment = 'production') desc,
       a.environment,
       a.channel_id
  ),
  -- +1 lookahead(잠긴 행 제외 후에도 남는 unlocked 후보)로 has_more 판정, heal은 v_limit.
  selected as materialized (
    select *
      from resolved
     order by game_id, user_id
     limit v_limit
  ),
  updated as (
    update public.live_activity_started_users tgt
       set channel_born_environment = sel.environment,
           channel_born_channel_id = sel.channel_id
      from selected sel
     where tgt.game_id = sel.game_id
       and tgt.user_id = sel.user_id
       and tgt.channel_born_channel_id is null
    returning tgt.game_id
  )
  select
    v_active_count,
    (select count(*)::integer from selected),
    (select count(*)::integer from updated),
    (select count(*) > v_limit from locked);
end;
$$;

revoke all on function public.reconcile_live_activity_channel_born(integer) from public;
grant execute on function public.reconcile_live_activity_channel_born(integer) to service_role;
