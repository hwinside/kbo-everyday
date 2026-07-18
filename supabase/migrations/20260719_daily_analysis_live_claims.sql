-- 순위 AI분석 live(당일 즉시 반영) 트리거의 원자적 claim(멱등성 race 방지) + lease(크래시 복구).
--
-- 배경(삼순 PR #690 P0②): 기존 live 크론은 SELECT sameDayLive → Gemini → upsert 순서라 atomic이
-- 아니어서, 겹치는 tick/수동 트리거 동시 호출 시 중복 생성 가능. saveDate-unique claim으로 한
-- 인보케이션만 생성을 진행하게 한다. lease(claimed_at) 경과 시 재획득 가능 → 크래시 복구.

create table if not exists public.daily_analysis_live_claims (
  analysis_date date primary key,
  claimed_at    timestamptz not null default now()
);

-- service_role 전용(정책 0 = anon/authenticated 거부, service_role은 RLS 우회).
alter table public.daily_analysis_live_claims enable row level security;

-- 원자적 claim: 미존재면 삽입, 존재하되 lease 경과면 재획득. 둘 다 아니면 no-op(false).
create or replace function public.claim_daily_analysis_live(p_date date, p_lease_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  insert into public.daily_analysis_live_claims (analysis_date, claimed_at)
  values (p_date, now())
  on conflict (analysis_date) do update
    set claimed_at = now()
    where public.daily_analysis_live_claims.claimed_at < now() - make_interval(secs => p_lease_seconds)
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.claim_daily_analysis_live(date, int) from public;
revoke all on function public.claim_daily_analysis_live(date, int) from anon;
revoke all on function public.claim_daily_analysis_live(date, int) from authenticated;
grant execute on function public.claim_daily_analysis_live(date, int) to service_role;
