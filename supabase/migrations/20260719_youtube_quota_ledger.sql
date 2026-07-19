-- 공유 YouTube Data API quota 원장 — 크론 간 quota 소비를 한 곳에서 추적/제한
-- 배경(2026-07-19): 선수 숏츠 크론이 하루 4회 중 21:30(quota 리셋 직후)만 성공하고
--   03:30·09:30·15:30은 quota 고갈로 전량 skip 하면서도 job status를 success로 오표기.
--   여러 YT 크론(videos-rss fallback/backfill, highlights _ALL 검색, videos-player-shorts,
--   신규 channel-discovery)이 공유 프로젝트 quota를 조율 없이 소비 → 이른 소진.
-- Google quota는 Pacific(America/Los_Angeles) 자정 리셋 → quota_date = Pacific 날짜.

create table if not exists youtube_quota_ledger (
  quota_date text primary key,          -- Pacific(LA) 날짜 'YYYY-MM-DD'
  used int not null default 0,
  updated_at timestamptz not null default now()
);

comment on table youtube_quota_ledger is
  '공유 YouTube Data API quota 소비 원장 (Pacific 날짜 단위, 크론 간 cap 조정)';

alter table youtube_quota_ledger enable row level security;

create policy "yql_service_all" on youtube_quota_ledger for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- 원자적 예약: used + p_units <= p_cap 이면 증가 후 allowed=true(소비 기록 겸함),
-- 아니면 미증가 + allowed=false. row lock(for update)으로 동시 크론 경쟁 방지.
create or replace function reserve_youtube_quota(p_date text, p_units int, p_cap int)
returns table(allowed boolean, used_after int, remaining int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
begin
  insert into youtube_quota_ledger(quota_date, used)
    values (p_date, 0)
    on conflict (quota_date) do nothing;

  select used into v_used
    from youtube_quota_ledger
    where quota_date = p_date
    for update;

  if v_used + p_units <= p_cap then
    update youtube_quota_ledger
      set used = used + p_units, updated_at = now()
      where quota_date = p_date;
    return query select true, v_used + p_units, p_cap - (v_used + p_units);
  else
    return query select false, v_used, greatest(p_cap - v_used, 0);
  end if;
end;
$$;

comment on function reserve_youtube_quota is
  'quota 원장 원자적 예약 — used+units<=cap 이면 증가+allowed, 아니면 미증가+거부';

-- 비조건 소비 기록: 고우선순위 잡(highlights 본수집, videos-rss fallback/backfill)은
-- cap과 무관하게 실행되지만, 실제 소비량을 원장에 기록해 저우선 잡(player-shorts)이
-- 정확한 잔여로 yield 하게 한다.
create or replace function record_youtube_quota(p_date text, p_units int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
begin
  insert into youtube_quota_ledger(quota_date, used)
    values (p_date, p_units)
    on conflict (quota_date)
    do update set used = youtube_quota_ledger.used + p_units, updated_at = now()
    returning used into v_used;
  return v_used;
end;
$$;

comment on function record_youtube_quota is
  'quota 소비 비조건 기록 — 고우선순위 잡이 실소비를 원장에 누적(cap 무관)';
