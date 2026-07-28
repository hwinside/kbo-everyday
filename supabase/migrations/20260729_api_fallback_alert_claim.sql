-- API 열화 durable 감지·경보 claim (장애대책 슬라이스1, 삼순 NO-GO 반영).
--
-- 배경: 기존 api-fallback-tracker 의 count/cooldown 은 in-memory(recentFallbacks,
-- lastAlertTime)라 서버리스 인스턴스별 독립이다. 2026-07-28 종료경기 AI요약 전면중단
-- 사고처럼 3경기 열화가 서로 다른 Vercel 인스턴스에 분산되면 각 count=1 → "5분 내 3회면
-- 경보"가 성립하지 않아 감지 자체가 안 된다(반대로 warm instance 여러 개면 중복 경보).
--
-- 처방: 이벤트 저장 + window count + cooldown claim 을 하나의 원자 RPC 로 durable 하게 판정한다.
--   - api_fallback_events insert 는 항상 수행(일일 리포트/추이 SSOT).
--   - api_name 별 advisory xact lock 으로 count~claim 사이 race 직렬화 → 분산돼도 경보 1회.
--   - cooldown 은 api_fallback_alert_state 의 upsert-where 로 원자적 claim(동시 요청 1개만 통과).
--   - should_alert(boolean) 을 반환 → 호출측(tracker)이 true 일 때만 텔레그램 발송.

create table if not exists public.api_fallback_alert_state (
  api_name text primary key,
  last_alerted_at timestamptz not null
);

comment on table public.api_fallback_alert_state is
  'API 열화 경보 cooldown 상태(api_name 별 마지막 경보 시각). record_api_fallback_and_claim 이 원자적으로 갱신.';

create or replace function public.record_api_fallback_and_claim(
  p_api_name text,
  p_reason text,
  p_status_code int,
  p_error_message text,
  p_window_minutes int,
  p_threshold int,
  p_cooldown_minutes int
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
  v_claimed int;
begin
  if p_api_name is null or p_api_name = '' then
    raise exception 'api_name required';
  end if;
  if p_threshold is null or p_threshold < 1 then
    raise exception 'threshold must be >= 1';
  end if;

  -- durable 이벤트 기록(항상). 일일 리포트/추이 집계의 SSOT.
  insert into public.api_fallback_events (api_name, reason, status_code, error_message, alert_sent)
  values (p_api_name, p_reason, p_status_code, p_error_message, false);

  -- api_name 별 직렬화: window count 읽기 ~ cooldown claim 사이 race 를 막아
  -- 서로 다른 서버리스 인스턴스의 동시 호출에서도 경보를 정확히 1회만 낸다.
  perform pg_advisory_xact_lock(hashtext('api_fallback_alert:' || p_api_name));

  -- 최근 window 내 같은 api_name 이벤트 수(방금 insert 포함). durable 이라 인스턴스 무관.
  select count(*) into v_count
    from public.api_fallback_events
   where api_name = p_api_name
     and timestamp >= now() - make_interval(mins => p_window_minutes);

  if v_count < p_threshold then
    return false;
  end if;

  -- 원자적 cooldown claim: 마지막 경보가 cooldown 밖일 때만 갱신 성공.
  -- 신규(행 부재)면 insert 성공, 기존이면 do update WHERE 통과 시에만 갱신 → 둘 다 row_count=1.
  -- cooldown 중이면 conflict + WHERE 불통과로 row_count=0.
  insert into public.api_fallback_alert_state (api_name, last_alerted_at)
  values (p_api_name, now())
  on conflict (api_name) do update
    set last_alerted_at = now()
    where public.api_fallback_alert_state.last_alerted_at < now() - make_interval(mins => p_cooldown_minutes);

  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return false; -- cooldown 중 → 경보 스킵
  end if;

  -- 경보 확정 → 이 api_name 의 가장 최근 이벤트를 alert_sent 로 마킹(대시보드/추적용).
  update public.api_fallback_events
     set alert_sent = true
   where id = (
     select id from public.api_fallback_events
      where api_name = p_api_name
      order by timestamp desc, id desc
      limit 1
   );

  return true;
end;
$$;

revoke all on function public.record_api_fallback_and_claim(text, text, int, text, int, int, int)
  from public, anon, authenticated;
grant execute on function public.record_api_fallback_and_claim(text, text, int, text, int, int, int)
  to service_role;
