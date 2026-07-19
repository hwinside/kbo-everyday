-- 공유 YouTube Data API quota 원장 — 크론 간 quota 소비를 한 곳에서 추적/제한
-- 배경(2026-07-19): 선수 숏츠 크론이 하루 4회 중 21:30(Pacific quota 리셋 직후)만 성공하고
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

-- 날짜 계약 검증 헬퍼 (YYYY-MM-DD)
create or replace function _assert_quota_date(p_date text)
returns void
language plpgsql
immutable
as $$
begin
  if p_date is null or p_date !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'invalid quota_date: %', p_date using errcode = '22007';
  end if;
end;
$$;

-- 프로젝트 절대 quota 상한(하드 리밋). TS resolveQuotaCap 과 동일값(10,000).
-- 어떤 호출부·env가 이보다 큰 cap 을 넘겨도 서버에서 강제로 clamp 한다
-- (삼순 #709 2번: 10M 허용이 한도 우회로 이어져 절대 yield 안 하는 상태 방지).
-- quota 증량 승인 시 이 상수 + TS 상수를 함께 올린다.
create or replace function _yt_quota_hard_max()
returns int language sql immutable as $$ select 10000 $$;

-- 원자적 예약: used + p_units <= 유효 cap 이면 증가 후 allowed=true(소비 기록 겸함),
-- 아니면 미증가 + allowed=false. row lock(for update)으로 동시 크론 경쟁 방지.
-- 유효 cap = least(p_cap, 하드리밋) — env·호출부가 넘긴 cap 도 절대 한도 초과 불가.
-- SECURITY DEFINER 이므로 입력을 서버에서 강하게 검증(음수 units/비정상 cap/date 우회 차단).
create or replace function reserve_youtube_quota(p_date text, p_units int, p_cap int)
returns table(allowed boolean, used_after int, remaining int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
  v_cap int;
begin
  perform _assert_quota_date(p_date);
  if p_units is null or p_units <= 0 then
    raise exception 'p_units must be > 0, got %', p_units using errcode = '22023';
  end if;
  if p_cap is null or p_cap <= 0 then
    raise exception 'p_cap must be > 0, got %', p_cap using errcode = '22023';
  end if;
  -- 하드 리밋 강제: 요청 cap 이 절대 한도를 넘어도 한도로 clamp.
  v_cap := least(p_cap, _yt_quota_hard_max());

  insert into youtube_quota_ledger(quota_date, used)
    values (p_date, 0)
    on conflict (quota_date) do nothing;

  select used into v_used
    from youtube_quota_ledger
    where quota_date = p_date
    for update;

  if v_used + p_units <= v_cap then
    update youtube_quota_ledger
      set used = used + p_units, updated_at = now()
      where quota_date = p_date;
    return query select true, v_used + p_units, v_cap - (v_used + p_units);
  else
    return query select false, v_used, greatest(v_cap - v_used, 0);
  end if;
end;
$$;

comment on function reserve_youtube_quota is
  'quota 원장 원자적 예약 — used+units<=cap 이면 증가+allowed, 아니면 미증가+거부. service_role 전용.';

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
  perform _assert_quota_date(p_date);
  if p_units is null or p_units <= 0 then
    raise exception 'p_units must be > 0, got %', p_units using errcode = '22023';
  end if;

  insert into youtube_quota_ledger(quota_date, used)
    values (p_date, p_units)
    on conflict (quota_date)
    do update set used = youtube_quota_ledger.used + p_units, updated_at = now()
    returning used into v_used;
  return v_used;
end;
$$;

comment on function record_youtube_quota is
  'quota 소비 비조건 기록 — 고우선순위 잡이 실소비를 원장에 누적(cap 무관). service_role 전용.';

-- ── 권한: SECURITY DEFINER 함수는 RLS로 막히지 않으므로 명시적으로 PUBLIC/anon/
--    authenticated EXECUTE 를 회수하고 service_role 에만 부여(20260421 패턴). ──
revoke all on function reserve_youtube_quota(text, int, int) from public;
revoke all on function reserve_youtube_quota(text, int, int) from anon;
revoke all on function reserve_youtube_quota(text, int, int) from authenticated;
grant execute on function reserve_youtube_quota(text, int, int) to service_role;

revoke all on function record_youtube_quota(text, int) from public;
revoke all on function record_youtube_quota(text, int) from anon;
revoke all on function record_youtube_quota(text, int) from authenticated;
grant execute on function record_youtube_quota(text, int) to service_role;

-- 내부 헬퍼도 노출 회수
revoke all on function _assert_quota_date(text) from public;
revoke all on function _assert_quota_date(text) from anon;
revoke all on function _assert_quota_date(text) from authenticated;

revoke all on function _yt_quota_hard_max() from public;
revoke all on function _yt_quota_hard_max() from anon;
revoke all on function _yt_quota_hard_max() from authenticated;
