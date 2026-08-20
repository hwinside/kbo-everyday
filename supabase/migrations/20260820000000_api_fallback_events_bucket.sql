-- api_fallback_events 폴링 증폭 차단 [EXPAND 단계]
--
-- 배경(2026-08-20 실측):
--   라이브 경기 중 `kbo-game-detail`/`schema-error` 가 하루 138,708행. 시간대 분포가
--   19~22시에만 몰리고 error_message 는 gameId 하나에 52,297건이었다. 즉 "장애가 13.8만 번"이
--   아니라 **유저 폴링 수만큼 로그를 남기는 계측 설계 결함**이다.
--
-- ⚠️ 1차 설계(이벤트마다 UPSERT count+1)는 삼순 NO-GO 를 받았다. 행 수만 줄고 **DB 쓰기
--    횟수와 WAL 은 그대로**이며, 오히려 같은 행을 계속 갱신해 HOT update 가 막히고
--    hot-row lock contention 이 생긴다. 그래서 진짜 해법은 **앱 단에서 delta 를 모아
--    주기적으로 1회 flush** 하는 것이고, DB 는 그 batch 를 받는다.
--
-- 이 파일이 하는 일:
--   ① 버킷 스키마(scope/fingerprint/event_count/bucket_start)
--   ② batch upsert + 임계 판정을 한 번에 하는 flush RPC
--   ③ **기존 8-인자 claim_api_fallback_alert 를 wrapper 로 보존**(expand/contract 중 expand)
--      → 배포 순서 어느 쪽이든 한쪽 RPC 가 없는 창이 생기지 않는다. 옛 시그니처 제거는
--        앱 배포 완료 + old deployment drain 확인 후 별도 contract migration 에서 한다.
--   ④ 소비처용 서버 집계 RPC(무페이지 select 로 1,000행 cap 에 잘리던 문제)

-- ── ① 스키마 ──────────────────────────────────────────────────────────────
alter table public.api_fallback_events
  add column if not exists scope text,
  add column if not exists fingerprint text,
  add column if not exists event_count int not null default 1,
  add column if not exists bucket_start timestamptz;

comment on column public.api_fallback_events.scope is
  'dedupe 축(예: gameId). null 은 scope 없는 이벤트.';
comment on column public.api_fallback_events.fingerprint is
  '오류 지문(정규화된 error_message 해시). 같은 분·같은 reason 이라도 서로 다른 오류를 한 행으로 '
  '뭉개지 않기 위한 축 — coarse reason 만 키로 쓰면 마지막 메시지 하나만 남는다(삼순 blocker 4).';
comment on column public.api_fallback_events.event_count is
  '이 버킷에서 합산된 폴백 발생 횟수. 창 집계는 count(*) 가 아니라 sum(event_count) 로 읽는다.';
comment on column public.api_fallback_events.bucket_start is
  '1분 버킷 시작(UTC). 과거 행(마이그레이션 이전)은 null 이며 event_count 는 DDL default 로 1 백필됐다.';

-- 과거 행(bucket_start null)은 부분 인덱스 밖 → 대량 UPDATE 없이 공존한다.
create unique index if not exists uq_api_fallback_events_bucket
  on public.api_fallback_events (api_name, reason, coalesce(scope, ''), coalesce(fingerprint, ''), bucket_start)
  where bucket_start is not null;

-- 창 집계(sum) 전용 커버링.
create index if not exists idx_api_fallback_events_window
  on public.api_fallback_events (api_name, timestamp desc)
  include (event_count);

-- ── ② batch flush: 여러 버킷 delta 를 1회 호출로 반영 + 임계 판정 ───────────
--
-- 입력 p_events: [{ api_name, reason, status_code, error_message, scope, fingerprint, count,
--                   window_minutes, threshold, cooldown_minutes, lease_seconds }, ...]
-- 반환: 경보 전송을 담당해야 하는 (api_name, attempt_token, reason, error_message) 행들.
--
-- 앱은 30초 창 동안 메모리에 delta 를 모아 이 함수를 **1회** 호출한다. 5,000건 폴백이
-- 5,000 write 가 아니라 1 write batch 가 된다 — 이것이 blocker 1 의 실제 해법이다.
create or replace function public.flush_api_fallback_buckets(p_events jsonb)
returns table(
  -- ⚠️ OUT 파라미터는 함수 본문 전체에서 변수처럼 보이므로 피연산 테이블 컴럼명(api_name,
  --    reason, error_message)과 같으면 INSERT/SELECT 안에서 "ambiguous" 로 죽는다.
  --    out_ 접두사로 이름공간을 분리한다(호출부는 이 이름으로 읽는다).
  out_api_name text,
  out_attempt_token uuid,
  out_reason text,
  out_error_message text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e jsonb;
  v_bucket timestamptz;
  v_api text;
  v_count bigint;
  v_event_id bigint;
  v_token uuid;
  v_state public.api_fallback_alert_state%rowtype;
  v_policies jsonb := '{}'::jsonb;
  v_last_event jsonb;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'p_events must be a jsonb array';
  end if;
  if jsonb_array_length(p_events) = 0 then
    return;
  end if;

  v_bucket := date_trunc('minute', now());

  -- (1) 모든 delta 를 버킷에 반영. 같은 키가 여러 번 오면 누적된다.
  for e in select value from jsonb_array_elements(p_events)
  loop
    v_api := e->>'api_name';
    if v_api is null or v_api = '' then
      raise exception 'api_name required';
    end if;
    if coalesce((e->>'threshold')::int, 1) < 1 then
      raise exception 'threshold must be >= 1';
    end if;
    if coalesce((e->>'lease_seconds')::int, 1) < 1 then
      raise exception 'lease_seconds must be >= 1';
    end if;

    insert into public.api_fallback_events
      (api_name, reason, status_code, error_message, scope, fingerprint,
       bucket_start, timestamp, event_count, alert_sent)
    values
      (v_api, e->>'reason', (e->>'status_code')::int, e->>'error_message',
       e->>'scope', e->>'fingerprint', v_bucket, now(),
       greatest(coalesce((e->>'count')::int, 1), 1), false)
    on conflict (api_name, reason, coalesce(scope, ''), coalesce(fingerprint, ''), bucket_start)
      where bucket_start is not null
    do update set
      event_count = public.api_fallback_events.event_count
                    + greatest(coalesce((e->>'count')::int, 1), 1),
      status_code = coalesce(excluded.status_code, public.api_fallback_events.status_code),
      error_message = coalesce(excluded.error_message, public.api_fallback_events.error_message),
      timestamp = excluded.timestamp
    returning id into v_event_id;

    -- api_name 별 정책·대표 이벤트 기억(마지막 것 사용)
    v_policies := v_policies || jsonb_build_object(
      v_api,
      jsonb_build_object(
        'window_minutes', coalesce((e->>'window_minutes')::int, 5),
        'threshold', coalesce((e->>'threshold')::int, 3),
        'cooldown_minutes', coalesce((e->>'cooldown_minutes')::int, 30),
        'lease_seconds', coalesce((e->>'lease_seconds')::int, 120),
        'reason', e->>'reason',
        'error_message', e->>'error_message',
        'event_id', v_event_id
      )
    );
  end loop;

  -- (2) api_name 별 임계 판정 + outbox claim
  for v_api, v_last_event in select key, value from jsonb_each(v_policies)
  loop
    perform pg_advisory_xact_lock(hashtext('api_fallback_alert:' || v_api));

    -- coalesce(event_count, 1): 마이그레이션 이전 행은 1건을 뜻한다.
    -- ⚠️ row count 가 아니라 sum(event_count) 여야 한다. row 로 세면 같은 키가 몇 번
    --    터져도 1행이라 임계에 도달하지 못해 경보가 영구 미발송된다.
    select coalesce(sum(coalesce(ev.event_count, 1)), 0) into v_count
      from public.api_fallback_events ev
     where ev.api_name = v_api
       and ev.timestamp >= now() - make_interval(mins => (v_last_event->>'window_minutes')::int);
    if v_count < (v_last_event->>'threshold')::int then
      continue;
    end if;

    select * into v_state from public.api_fallback_alert_state s where s.api_name = v_api;

    if v_state.last_alerted_at is not null
       and v_state.last_alerted_at >= now() - make_interval(mins => (v_last_event->>'cooldown_minutes')::int) then
      continue;
    end if;
    if v_state.pending_event_id is not null then
      continue;
    end if;

    v_token := gen_random_uuid();
    insert into public.api_fallback_alert_state as s (
      api_name, pending_event_id, pending_reason, pending_error_message,
      pending_since, next_attempt_at, attempt_token, locked_until, attempt_count
    ) values (
      v_api, (v_last_event->>'event_id')::bigint, v_last_event->>'reason',
      v_last_event->>'error_message',
      now(), now(), v_token,
      now() + make_interval(secs => (v_last_event->>'lease_seconds')::int), 1
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
           or s.last_alerted_at < now() - make_interval(mins => (v_last_event->>'cooldown_minutes')::int));

    if not found then
      continue; -- 동시 claim 이 먼저 outbox 생성
    end if;

    out_api_name := v_api;
    out_attempt_token := v_token;
    out_reason := v_last_event->>'reason';
    out_error_message := v_last_event->>'error_message';
    return next;
  end loop;
end;
$$;

revoke all on function public.flush_api_fallback_buckets(jsonb) from public, anon, authenticated;
grant execute on function public.flush_api_fallback_buckets(jsonb) to service_role;

-- ── ③ EXPAND: 옛 8-인자 claim 을 wrapper 로 보존 ───────────────────────────
--
-- 삼순 blocker 2: `Vercel→migration` 도 `migration→Vercel` 도 한쪽 RPC 가 없는 창이 생긴다.
-- 그래서 이 migration 은 **아무것도 drop 하지 않는다.** 옛 시그니처는 신규 경로로 위임하는
-- wrapper 로 남아 구버전 배포가 살아있어도 정상 동작한다.
-- 제거는 앱 배포 + old deployment drain 확인 후 contract migration 에서.
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
  -- ⚠️ OUT 파라미터 attempt_token 과 호출 결과 컴럼명이 같아 plpgsql 가 모호하다고 거부한다.
  --    그래서 결과를 전용 지역변수로 받는다(별칭만으로는 해결되지 않는다).
  v_token uuid;
begin
  -- 구버전 호출은 scope/fingerprint 가 없다 → null 로 흘려보낸다(옛 동작과 동일한 묶음).
  select f.out_attempt_token into v_token
    from public.flush_api_fallback_buckets(
      jsonb_build_array(jsonb_build_object(
        'api_name', p_api_name,
        'reason', p_reason,
        'status_code', p_status_code,
        'error_message', p_error_message,
        'scope', null,
        'fingerprint', null,
        'count', 1,
        'window_minutes', p_window_minutes,
        'threshold', p_threshold,
        'cooldown_minutes', p_cooldown_minutes,
        'lease_seconds', p_lease_seconds
      ))
    ) f
   limit 1;

  if v_token is null then
    return query select false, null::uuid;
  else
    return query select true, v_token;
  end if;
end;
$$;

revoke all on function public.claim_api_fallback_alert(text, text, int, text, int, int, int, int) from public, anon, authenticated;
grant execute on function public.claim_api_fallback_alert(text, text, int, text, int, int, int, int) to service_role;

-- ── ④ 소비처용 서버 집계 ──────────────────────────────────────────────────
--
-- 삼순 blocker 3: monitoring/fallbacks 와 daily-fallback-report 가 무페이지 `.select("*")` 라
-- Supabase 기본 1,000행 cap 에 잘린다. 분당 버킷도 경기일엔 하루 1,000행을 넘을 수 있어
-- sum(event_count) 리포트가 계속 오보가 된다. → 집계를 DB 로 내린다(행을 안 가져온다).
create or replace function public.summarize_api_fallbacks(
  p_since timestamptz,
  p_until timestamptz default null,
  p_api_name text default null
)
returns table(
  api_name text,
  reason text,
  occurrences bigint,
  rows_stored bigint,
  latest_at timestamptz,
  latest_message text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    ev.api_name,
    ev.reason,
    sum(coalesce(ev.event_count, 1))::bigint as occurrences,
    count(*)::bigint as rows_stored,
    max(ev.timestamp) as latest_at,
    (array_agg(ev.error_message order by ev.timestamp desc))[1] as latest_message
  from public.api_fallback_events ev
  where ev.timestamp >= p_since
    and (p_until is null or ev.timestamp < p_until)
    and (p_api_name is null or ev.api_name = p_api_name)
  group by ev.api_name, ev.reason
  order by occurrences desc;
$$;

comment on function public.summarize_api_fallbacks(timestamptz, timestamptz, text) is
  'API 열화 집계 — 행을 클라로 가져오지 않는다(무페이지 select 1,000행 cap 회피). '
  'occurrences=sum(event_count) 가 실제 발생 횟수, rows_stored 는 저장된 버킷 행 수.';

revoke all on function public.summarize_api_fallbacks(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.summarize_api_fallbacks(timestamptz, timestamptz, text) to service_role;
