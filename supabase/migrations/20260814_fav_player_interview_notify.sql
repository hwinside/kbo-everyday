-- 최애선수 수훈선수 인터뷰 알림 (fav-player-interview.ts, 2026-08-14 하린아빠 요청)
--
-- 1) 토글 컬럼 — 디폴트 on(기존 row/유저 전부 on 유지, 백필 불필요).
alter table notification_prefs
  add column if not exists fav_player_interview boolean not null default true;

-- 2) 발송 상태 머신.
alter table postgame_interviews
  add column if not exists notify_state text not null default 'pending'
    check (notify_state in ('pending', 'processing', 'sent'));
alter table postgame_interviews
  add column if not exists notify_lease_until timestamptz;

-- 3) backlog 방어: 배포 이전 인터뷰는 전부 sent로 백필한다.
update postgame_interviews
   set notify_state = 'sent', notify_lease_until = null
 where notify_state <> 'sent';

create index if not exists idx_postgame_interviews_notify_pending
  on postgame_interviews (published_at, id)
  where notify_state <> 'sent' and confidence = 'high';

-- 4) bounded atomic lease. 단순 UPDATE+limit 없는 PostgREST 배선은 동시 run에서
--    lock 대기 후 WHERE 재평가 계약과 상한을 증명하기 어렵다. DB 함수 안에서
--    ORDER BY + LIMIT + FOR UPDATE SKIP LOCKED로 최대 p_limit행만 원자 선점한다.
create or replace function public.claim_postgame_interview_notifications(
  p_limit integer default 40,
  p_lease_seconds integer default 600
)
returns setof postgame_interviews
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select p.id
      from postgame_interviews p
     where p.confidence = 'high'
       and (
         p.notify_state = 'pending'
         or (p.notify_state = 'processing' and p.notify_lease_until < clock_timestamp())
       )
     order by p.published_at asc, p.id asc
     limit greatest(1, least(coalesce(p_limit, 40), 40))
     for update skip locked
  )
  update postgame_interviews p
     set notify_state = 'processing',
         notify_lease_until = clock_timestamp()
           + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 600), 900)))
    from candidates c
   where p.id = c.id
  returning p.*;
end;
$$;

revoke all on function public.claim_postgame_interview_notifications(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_postgame_interview_notifications(integer, integer)
  to service_role;
