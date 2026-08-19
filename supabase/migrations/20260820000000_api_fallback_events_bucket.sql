-- api_fallback_events 폴링 증폭 차단 — 이벤트 1행/폴백 → (api, reason, scope, 분버킷) 1행 + count.
--
-- 배경(2026-08-20 실측):
--   라이브 경기 중 `kbo-game-detail`/`schema-error` 가 하루 138,708행. 시간대 분포가
--   19~22시에만 몰리고 error_message 는 gameId 하나에 52,297건이었다. 즉 "장애가 13.8만 번"이
--   아니라 **유저 폴링 수만큼 로그를 남기는 계측 설계 결함**이다.
--   기존 tracker 는 임계치/쿨다운으로 *텔레그램 전송만* 억제하고 DB INSERT 는 폴백 1회당
--   무조건 1행이었다(saveToSupabase / claim_api_fallback_alert 둘 다).
--
-- 계약 변경:
--   같은 (api_name, reason, scope, 1분 버킷) 은 **1행**이며 반복 폴백은 event_count 만 증가한다.
--   경보 판정의 "창 내 발생 횟수"는 row count 가 아니라 **sum(event_count)** 다 — 이 두 값이
--   갈라지면 임계치가 조용히 헐거워지므로, 창 집계는 반드시 sum(event_count) 로 읽는다.
--
-- 보존:
--   alert_sent 는 여전히 *그 버킷 행*에 귀속된다(pending_event_id → 버킷 id). outbox/토큰
--   fence(20260729) 의미는 그대로다.

-- ── ① 스키마 확장 ──────────────────────────────────────────────────────────
alter table public.api_fallback_events
  add column if not exists scope text,
  add column if not exists event_count int not null default 1,
  add column if not exists bucket_start timestamptz;

comment on column public.api_fallback_events.scope is
  'dedupe 축(예: gameId). null 은 scope 없는 이벤트. (api_name, reason, scope, bucket_start) 가 1행.';
comment on column public.api_fallback_events.event_count is
  '이 버킷에서 합산된 폴백 발생 횟수. 창 집계는 count(*) 가 아니라 sum(event_count) 로 읽는다.';
comment on column public.api_fallback_events.bucket_start is
  '1분 버킷 시작(UTC, date_trunc). 과거 행(마이그레이션 이전)은 null 이며 count 1로 취급된다.';

-- 과거 행은 버킷 키가 없다. 새 unique 인덱스가 과거 행과 충돌하지 않도록 bucket_start 가
-- not null 인 행에만 유일성을 건다(부분 인덱스). 과거 행은 건드리지 않는다(대량 UPDATE 금지 —
-- WAL/dead tuple 급증 방지, 삼순 2026-08-20 지적).
create unique index if not exists uq_api_fallback_events_bucket
  on public.api_fallback_events (api_name, reason, coalesce(scope, ''), bucket_start)
  where bucket_start is not null;

-- 창 집계(sum) 전용 — (api_name, timestamp) 복합 인덱스는 이미 있으나 event_count 를 포함해
-- index-only scan 이 되도록 커버링을 추가한다.
create index if not exists idx_api_fallback_events_window
  on public.api_fallback_events (api_name, timestamp desc)
  include (event_count);

-- ── ② 버킷 upsert 헬퍼 ────────────────────────────────────────────────────
-- 반환: 그 버킷 행 id. 신규 생성이든 count 증가든 항상 동일 행 id 를 돌려준다.
create or replace function public.record_api_fallback_bucket(
  p_api_name text,
  p_reason text,
  p_status_code int,
  p_error_message text,
  p_scope text
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bucket timestamptz;
  v_id bigint;
begin
  if p_api_name is null or p_api_name = '' then
    raise exception 'api_name required';
  end if;
  v_bucket := date_trunc('minute', now());

  insert into public.api_fallback_events
    (api_name, reason, status_code, error_message, scope, bucket_start, timestamp, event_count, alert_sent)
  values
    (p_api_name, p_reason, p_status_code, p_error_message, p_scope, v_bucket, now(), 1, false)
  on conflict (api_name, reason, coalesce(scope, ''), bucket_start)
    where bucket_start is not null
  do update set
    event_count = public.api_fallback_events.event_count + 1,
    -- 마지막 관측을 남긴다. status_code/error_message 는 같은 버킷 내에서 동일하다고 가정하지
    -- 않는다(예: timeout 뒤 http-error 는 reason 이 달라 다른 버킷이지만, status_code 는 변할 수 있음).
    status_code = coalesce(excluded.status_code, public.api_fallback_events.status_code),
    error_message = coalesce(excluded.error_message, public.api_fallback_events.error_message),
    timestamp = excluded.timestamp
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_api_fallback_bucket(text, text, int, text, text) is
  '폴백 이벤트를 (api, reason, scope, 1분버킷) 단위로 upsert 하고 그 행 id 를 반환. 폴링 증폭 차단.';

revoke all on function public.record_api_fallback_bucket(text, text, int, text, text) from public, anon, authenticated;
grant execute on function public.record_api_fallback_bucket(text, text, int, text, text) to service_role;

-- ── ③ claim RPC: 버킷 upsert + sum(event_count) 판정으로 교체 ──────────────
-- 시그니처에 p_scope 를 추가한다. 기존 8-인자 시그니처는 아래에서 drop 해 **호출부가 조용히
-- 옛 함수로 떨어지지 않게** 한다(두 시그니처 공존 시 scope 없는 옛 경로가 계속 1행/폴백을
-- 쌓아도 아무도 모른다 — fail-close).
create or replace function public.claim_api_fallback_alert(
  p_api_name text,
  p_reason text,
  p_status_code int,
  p_error_message text,
  p_window_minutes int,
  p_threshold int,
  p_cooldown_minutes int,
  p_lease_seconds int,
  p_scope text
)
returns table(should_send boolean, attempt_token uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count bigint;
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

  -- 1행/폴백 insert → 버킷 upsert. 임계치 의미를 보존하려면 창 집계를 sum(event_count) 로 읽어야 한다.
  v_event_id := public.record_api_fallback_bucket(
    p_api_name, p_reason, p_status_code, p_error_message, p_scope
  );

  perform pg_advisory_xact_lock(hashtext('api_fallback_alert:' || p_api_name));

  -- coalesce(event_count, 1): 마이그레이션 이전 행은 1건을 뜻한다.
  select coalesce(sum(coalesce(event_count, 1)), 0) into v_count
    from public.api_fallback_events
   where api_name = p_api_name
     and timestamp >= now() - make_interval(mins => p_window_minutes);
  if v_count < p_threshold then
    return query select false, null::uuid; return;
  end if;

  select * into v_state from public.api_fallback_alert_state where api_name = p_api_name;

  if v_state.last_alerted_at is not null
     and v_state.last_alerted_at >= now() - make_interval(mins => p_cooldown_minutes) then
    return query select false, null::uuid; return;
  end if;
  if v_state.pending_event_id is not null then
    return query select false, null::uuid; return;
  end if;

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
    return query select false, null::uuid; return;
  end if;
  return query select true, v_token;
end;
$$;

-- 옛 8-인자 시그니처 제거(fail-close): 남겨두면 scope 미전달 호출이 조용히 옛 경로로 떨어진다.
drop function if exists public.claim_api_fallback_alert(text, text, int, text, int, int, int, int);

revoke all on function public.claim_api_fallback_alert(text, text, int, text, int, int, int, int, text) from public, anon, authenticated;
grant execute on function public.claim_api_fallback_alert(text, text, int, text, int, int, int, int, text) to service_role;
