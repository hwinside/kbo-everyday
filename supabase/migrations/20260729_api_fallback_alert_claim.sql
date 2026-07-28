-- API 열화 durable 경보 outbox (장애대책 슬라이스1, 삼순 NO-GO 3회 반영).
--
-- 배경: 기존 tracker 의 count/cooldown 은 in-memory 라 서버리스 인스턴스 분산 시 감지가 깨진다.
-- 1차 반영: durable count + 원자 claim. 2차 반영: 전송 2xx 후에만 확정(outbox/lease + ACK).
-- 3차 반영(삼순):
--   [P0] "새 열화 이벤트가 와야" 재시도되는 구조라, 단발 outage 후 요청이 끊기면 lease 만
--        만료되고 경보가 영구 미발송이었다. → 새 이벤트와 독립적으로 due outbox 를 재전송하는
--        recovery drainer(cron)와 next_attempt_at/attempt_count 상태가 필요.
--   [P1] confirm 이 현재 lease 소유자를 확인하지 않아 stale confirm 이 남의 lease 를 지웠다.
--        → claim/drain 이 opaque attempt_token 을 발급하고, confirm/nack 는 그 토큰 소유자만
--        상태를 바꾸며 정확히 그 event 를 sent 처리한다. stale 은 no-op.
--
-- 구조: api_fallback_alert_state 를 api_name 별 1행 outbox 로 사용.
--   pending_event_id 가 set = "전송 대기 중 경보 있음". attempt_token 이 현재 in-flight 시도 소유자.
--   fast path(claim): 임계 도달 + cooldown 밖 + 활성 outbox 없음 → outbox 생성 + 첫 attempt 획득.
--   drainer(drain): due(next_attempt_at<=now) + 미in-flight(locked_until 만료) outbox → 새 토큰으로 재획득.
--   전송 2xx → confirm(토큰): cooldown 확정 + outbox 제거 + 그 event alert_sent. 실패 → nack(토큰): backoff 재예약.
--   crash(무confirm/무nack) → locked_until 만료 후 drainer 가 재획득. 최대 수명 초과 → drainer 가 give-up.

create table if not exists public.api_fallback_alert_state (
  api_name text primary key,
  last_alerted_at timestamptz,        -- 마지막 실제 전송(2xx) 확정 시각 → cooldown 기준
  pending_event_id bigint,            -- 활성 outbox: 전송 대기 이벤트 id. null = 대기 경보 없음
  pending_reason text,
  pending_error_message text,
  pending_since timestamptz,          -- outbox 생성 시각(최대 수명 give-up 기준)
  next_attempt_at timestamptz,        -- 다음 전송 시도 due 시각
  attempt_token uuid,                 -- 현재 in-flight 시도 소유 토큰. null = in-flight 아님
  locked_until timestamptz,           -- in-flight lease 만료(crash 복구용)
  attempt_count int not null default 0
);

comment on table public.api_fallback_alert_state is
  'API 열화 경보 outbox(api_name 별 1행): durable 재시도 + 전송 소유 토큰. service_role 전용.';

create index if not exists idx_api_fallback_alert_due
  on public.api_fallback_alert_state (next_attempt_at)
  where pending_event_id is not null;

-- 운영 내부 state → 서비스 롤 전용. anon/authenticated 직접 read/write 차단(cooldown 조작 방지).
alter table public.api_fallback_alert_state enable row level security;
revoke all on public.api_fallback_alert_state from public, anon, authenticated;
grant select, insert, update, delete on public.api_fallback_alert_state to service_role;

-- ── fast path: 이벤트 durable insert + 임계/쿨다운 판정 + outbox 생성 + 첫 attempt 획득 ──
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
returns table(should_send boolean, attempt_token uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
  v_event_id bigint;
  v_token uuid;
  v_state public.api_fallback_alert_state%rowtype;
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

  insert into public.api_fallback_events (api_name, reason, status_code, error_message, alert_sent)
  values (p_api_name, p_reason, p_status_code, p_error_message, false)
  returning id into v_event_id;

  perform pg_advisory_xact_lock(hashtext('api_fallback_alert:' || p_api_name));

  select count(*) into v_count
    from public.api_fallback_events
   where api_name = p_api_name
     and timestamp >= now() - make_interval(mins => p_window_minutes);
  if v_count < p_threshold then
    return query select false, null::uuid; return;
  end if;

  select * into v_state from public.api_fallback_alert_state where api_name = p_api_name;

  -- cooldown 중(최근 실제 전송 성공) → skip
  if v_state.last_alerted_at is not null
     and v_state.last_alerted_at >= now() - make_interval(mins => p_cooldown_minutes) then
    return query select false, null::uuid; return;
  end if;
  -- 이미 활성 outbox 있음 → drainer 가 재시도 담당(fast path 는 중복 생성 안 함)
  if v_state.pending_event_id is not null then
    return query select false, null::uuid; return;
  end if;

  -- 새 outbox 생성 + 첫 attempt 획득
  v_token := gen_random_uuid();
  insert into public.api_fallback_alert_state as s (
    api_name, pending_event_id, pending_reason, pending_error_message,
    pending_since, next_attempt_at, attempt_token, locked_until, attempt_count
  ) values (
    p_api_name, v_event_id, p_reason, p_error_message,
    now(), now(), v_token, now() + make_interval(secs => p_lease_seconds), 1
  )
  on conflict (api_name) do update set
    pending_event_id = excluded.pending_event_id,
    pending_reason = excluded.pending_reason,
    pending_error_message = excluded.pending_error_message,
    pending_since = now(),
    next_attempt_at = now(),
    attempt_token = excluded.attempt_token,
    locked_until = excluded.locked_until,
    attempt_count = 1
  where s.pending_event_id is null
    and (s.last_alerted_at is null
         or s.last_alerted_at < now() - make_interval(mins => p_cooldown_minutes));

  if not found then
    return query select false, null::uuid; return; -- 동시 claim 이 먼저 outbox 생성
  end if;
  return query select true, v_token;
end;
$$;

-- ── recovery drainer: 새 이벤트 없이도 due outbox 를 재획득(새 토큰). cron 이 호출. ──
create or replace function public.drain_api_fallback_alerts(
  p_lease_seconds int,
  p_max_age_minutes int,
  p_max_batch int
)
returns table(api_name text, attempt_token uuid, reason text, error_message text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_token uuid;
begin
  for r in
    select s.api_name as a, s.pending_since as psince, s.pending_reason as prsn, s.pending_error_message as perr
      from public.api_fallback_alert_state s
     where s.pending_event_id is not null
       and s.next_attempt_at <= now()
       and (s.locked_until is null or s.locked_until <= now())
     order by s.next_attempt_at
     limit greatest(p_max_batch, 1)
     for update skip locked
  loop
    -- 최대 수명 초과(영구 실패) → give-up: outbox 제거(무한 재시도 방지)
    if r.psince < now() - make_interval(mins => p_max_age_minutes) then
      update public.api_fallback_alert_state s set
        pending_event_id = null, pending_reason = null, pending_error_message = null,
        pending_since = null, next_attempt_at = null, attempt_token = null,
        locked_until = null, attempt_count = 0
      where s.api_name = r.a;
      continue;
    end if;
    v_token := gen_random_uuid();
    update public.api_fallback_alert_state s set
      attempt_token = v_token,
      locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
      attempt_count = s.attempt_count + 1
    where s.api_name = r.a;

    api_name := r.a; attempt_token := v_token; reason := r.prsn; error_message := r.perr;
    return next;
  end loop;
end;
$$;

-- ── 실제 2xx(ACK) 뒤에만: 현재 토큰 소유자만 cooldown 확정 + outbox 제거 + 그 event 마킹 ──
create or replace function public.confirm_api_fallback_alert(p_api_name text, p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id bigint;
begin
  select pending_event_id into v_event_id
    from public.api_fallback_alert_state
   where api_name = p_api_name and attempt_token = p_token;
  if not found then
    return false; -- stale/mismatch → no-op
  end if;

  update public.api_fallback_alert_state set
    last_alerted_at = now(),
    pending_event_id = null, pending_reason = null, pending_error_message = null,
    pending_since = null, next_attempt_at = null,
    attempt_token = null, locked_until = null, attempt_count = 0
  where api_name = p_api_name and attempt_token = p_token;

  if v_event_id is not null then
    update public.api_fallback_events set alert_sent = true where id = v_event_id; -- exact 귀속
  end if;
  return true;
end;
$$;

-- ── 전송 실패(비2xx/timeout): 현재 토큰 소유자만 backoff 재예약. stale 은 no-op. ──
create or replace function public.nack_api_fallback_alert(
  p_api_name text,
  p_token uuid,
  p_backoff_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hit int;
begin
  update public.api_fallback_alert_state set
    attempt_token = null,
    locked_until = null,
    next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_backoff_seconds, 60), 1))
  where api_name = p_api_name and attempt_token = p_token;
  get diagnostics v_hit = row_count;
  return v_hit > 0;
end;
$$;

revoke all on function public.claim_api_fallback_alert(text, text, int, text, int, int, int, int) from public, anon, authenticated;
revoke all on function public.drain_api_fallback_alerts(int, int, int) from public, anon, authenticated;
revoke all on function public.confirm_api_fallback_alert(text, uuid) from public, anon, authenticated;
revoke all on function public.nack_api_fallback_alert(text, uuid, int) from public, anon, authenticated;
grant execute on function public.claim_api_fallback_alert(text, text, int, text, int, int, int, int) to service_role;
grant execute on function public.drain_api_fallback_alerts(int, int, int) to service_role;
grant execute on function public.confirm_api_fallback_alert(text, uuid) to service_role;
grant execute on function public.nack_api_fallback_alert(text, uuid, int) to service_role;
