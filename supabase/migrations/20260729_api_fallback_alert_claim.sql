-- API 열화 durable 감지·경보 (장애대책 슬라이스1, 삼순 NO-GO 2회 반영: outbox/lease + 2xx ACK).
--
-- 배경: 기존 api-fallback-tracker 의 count/cooldown 은 in-memory 라 서버리스 인스턴스별 독립이다.
-- 2026-07-28 종료경기 AI요약 전면중단 사고처럼 열화가 여러 인스턴스로 분산되면 각 count=1 →
-- "5분 내 3회면 경보"가 성립하지 않아 감지 자체가 안 된다.
--
-- 삼순 2차 NO-GO 반영: 경보 확정(cooldown/alert_sent)을 텔레그램 전송 *전에* 하면,
-- 토큰 부재/4xx/5xx/timeout 로 실제 전송이 실패해도 cooldown 이 걸려 재시도가 억제되고 DB 는
-- sent=true 로 남는다(경보 유실). → claim / (2xx) / confirm 2단계 outbox·lease 구조로 바꾼다.
--   1) claim: 이벤트 durable insert + window count + (cooldown && lease) 원자 claim → should_send.
--      cooldown/alert_sent 은 여기서 확정하지 않는다. pending_lease 만 잡아 중복 전송을 막는다.
--   2) 호출측이 텔레그램 전송을 시도하고, 실제 2xx(ACK) 를 받은 뒤에만 confirm 을 호출한다.
--   3) confirm: last_alerted_at(=cooldown 기준) 확정 + lease 해제 + 최근 이벤트 alert_sent=true.
--   전송 실패 시 confirm 이 없으니 pending_lease 는 TTL 후 만료 → 다음 열화 이벤트가 재claim(재시도).
--
-- api_name 별 advisory xact lock + upsert-where 로 서버리스 인스턴스 분산에도 경보 정확히 1회.

create table if not exists public.api_fallback_alert_state (
  api_name text primary key,
  last_alerted_at timestamptz,   -- 마지막 실제 전송(2xx) 확정 시각 → cooldown 기준
  pending_lease_at timestamptz   -- 전송 시도 중(2xx 확정 전) lease → 중복 전송 방지, TTL 후 재시도
);

comment on table public.api_fallback_alert_state is
  'API 열화 경보 outbox 상태(api_name 별 1행): 전송 확정 cooldown + 진행 중 lease. service_role 전용.';

-- 운영 내부 state → 서비스 롤 전용. anon/authenticated 직접 read/write 차단(cooldown 조작 방지).
alter table public.api_fallback_alert_state enable row level security;
revoke all on public.api_fallback_alert_state from public, anon, authenticated;
grant select, insert, update, delete on public.api_fallback_alert_state to service_role;

create or replace function public.claim_api_fallback_alert(
  p_api_name text,
  p_reason text,
  p_status_code int,
  p_error_message text,
  p_window_minutes int,
  p_threshold int,
  p_cooldown_minutes int,
  p_lease_seconds int
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
  if p_lease_seconds is null or p_lease_seconds < 1 then
    raise exception 'lease_seconds must be >= 1';
  end if;

  -- durable 이벤트 기록(항상). 일일 리포트/추이 집계의 SSOT.
  insert into public.api_fallback_events (api_name, reason, status_code, error_message, alert_sent)
  values (p_api_name, p_reason, p_status_code, p_error_message, false);

  -- api_name 별 직렬화: window count 읽기 ~ claim 사이 race 를 막아 인스턴스 분산에도 경보 1회.
  perform pg_advisory_xact_lock(hashtext('api_fallback_alert:' || p_api_name));

  -- 최근 window 내 같은 api_name 이벤트 수(방금 insert 포함). durable 이라 인스턴스 무관.
  select count(*) into v_count
    from public.api_fallback_events
   where api_name = p_api_name
     and timestamp >= now() - make_interval(mins => p_window_minutes);

  if v_count < p_threshold then
    return false;
  end if;

  -- 원자적 claim: (cooldown 밖) AND (활성 lease 없음) 일 때만 pending_lease 를 잡는다.
  -- cooldown/alert_sent 은 여기서 확정하지 않는다 — 실제 2xx 전송 후 confirm 에서 확정.
  insert into public.api_fallback_alert_state (api_name, pending_lease_at)
  values (p_api_name, now())
  on conflict (api_name) do update
    set pending_lease_at = now()
    where (public.api_fallback_alert_state.last_alerted_at is null
           or public.api_fallback_alert_state.last_alerted_at < now() - make_interval(mins => p_cooldown_minutes))
      and (public.api_fallback_alert_state.pending_lease_at is null
           or public.api_fallback_alert_state.pending_lease_at < now() - make_interval(secs => p_lease_seconds));

  get diagnostics v_claimed = row_count;
  return v_claimed > 0; -- true = 이 호출이 전송 담당(should_send)
end;
$$;

-- 실제 텔레그램 2xx(ACK) 뒤에만 호출: cooldown 확정 + lease 해제 + 최근 이벤트 alert_sent 마킹.
create or replace function public.confirm_api_fallback_alert(p_api_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.api_fallback_alert_state
     set last_alerted_at = now(),
         pending_lease_at = null
   where api_name = p_api_name;

  update public.api_fallback_events
     set alert_sent = true
   where id = (
     select id from public.api_fallback_events
      where api_name = p_api_name
      order by timestamp desc, id desc
      limit 1
   );
end;
$$;

revoke all on function public.claim_api_fallback_alert(text, text, int, text, int, int, int, int)
  from public, anon, authenticated;
revoke all on function public.confirm_api_fallback_alert(text)
  from public, anon, authenticated;
grant execute on function public.claim_api_fallback_alert(text, text, int, text, int, int, int, int)
  to service_role;
grant execute on function public.confirm_api_fallback_alert(text)
  to service_role;
