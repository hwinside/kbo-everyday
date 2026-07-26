-- 경기 시작알림 상태 머신 (2026-07-26 인시던트 — cron 공백 전원 미발송 재발 차단, spec S1).
--
-- 기존 start_notified 단일 비트는 "발송/억제"를 한 비트에 종결해, cron 공백으로 첫 tick을
-- 놓치면 다음 tick이 mark-only(start_notified=true)로 굳혀 재발송 불가였다. 이를 lease 기반
-- 상태 머신으로 승격한다: idle → sending(lease) → sent | suppressed.
--   - start_state 가 새 SSOT. sent(=start_sent_at IS NOT NULL) 만 downstream(활약알림) 순서
--     게이트 근거가 된다(S2에서 사용).
--   - sending lease: 겹친 cron invocation 중복발송 방지. 앱의 120s lease는 warmup
--     maxDuration(75s)보다 길어 정상 invocation이 살아 있는 동안 T+60 cron 재선점을 막는다.
--     fanout은 lease_until 10s 전에 중단하고 deadline partial은 sending으로 남긴다.
--     크래시/절단 뒤 청크 중복·누락 없는 재개는 S3(start_fanout_cursor) 범위다.
--   - suppressed: 첫 타석 창을 지나 정당하게 시작알림을 안 보내기로 확정한 상태.
-- start_notified 컬럼은 read-compat로 유지(live-activity wake가 읽음) — sent/suppressed 전이
-- 시 true로 세팅해 기존 종료알림·LA wake 동작을 그대로 보존한다.
-- 멱등: 재실행 안전(IF NOT EXISTS / 조건부 백필 / 제약 존재 검사).

alter table game_notify_state
  add column if not exists start_state text not null default 'idle',
  add column if not exists start_sent_at timestamptz,
  add column if not exists start_lease_until timestamptz,
  add column if not exists start_lease_owner text,
  add column if not exists start_suppressed_reason text,
  add column if not exists start_fanout_cursor int;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'game_notify_state_start_state_chk'
  ) then
    alter table game_notify_state
      add constraint game_notify_state_start_state_chk
      check (start_state in ('idle', 'sending', 'sent', 'suppressed'));
  end if;
end $$;

-- 백필: 기존 발송분(start_notified=true)을 sent 로 승격. start_sent_at 은 알 수 있는 최선의
-- 발송 시각(updated_at)로, 없으면 now(). 이미 sent 인 행은 재실행 시 건너뛴다(멱등).
update game_notify_state
  set start_state = 'sent',
      start_sent_at = coalesce(start_sent_at, updated_at, now())
  where start_notified = true and start_state <> 'sent';

-- ── 상태 전이 RPC (service_role/cron 전용, DB now() 기준 원자 CAS) ──────────────

-- idle 또는 lease 만료된 sending 을 sending 으로 선점. 성공(1행 갱신)하면 true.
-- 겹친 invocation 은 행 락으로 직렬화되어 오직 한 호출만 true 를 받는다(중복발송 차단).
create or replace function claim_start_lease(
  p_game_id text,
  p_owner text,
  p_lease_seconds int
) returns boolean
language sql
set search_path = public
as $$
  with upd as (
    update game_notify_state
      set start_state = 'sending',
          start_lease_until = now() + make_interval(secs => p_lease_seconds),
          start_lease_owner = p_owner,
          updated_at = now()
      where game_id = p_game_id
        and (
          start_state = 'idle'
          or (start_state = 'sending' and start_lease_until < now())
        )
      returning 1
  )
  select exists (select 1 from upd);
$$;

-- sending(내 소유) → sent. start_sent_at·start_notified(read-compat) 세팅, lease 해제.
create or replace function mark_start_sent(
  p_game_id text,
  p_owner text
) returns void
language sql
set search_path = public
as $$
  update game_notify_state
    set start_state = 'sent',
        start_sent_at = now(),
        start_notified = true,
        start_lease_until = null,
        start_lease_owner = null,
        updated_at = now()
    where game_id = p_game_id
      and start_state = 'sending'
      and start_lease_owner = p_owner;
$$;

-- 발송 실패 시 sending(내 소유) → idle 복귀(다음 tick 재시도). lease 해제.
create or replace function release_start_lease(
  p_game_id text,
  p_owner text
) returns void
language sql
set search_path = public
as $$
  update game_notify_state
    set start_state = 'idle',
        start_lease_until = null,
        start_lease_owner = null,
        updated_at = now()
    where game_id = p_game_id
      and start_state = 'sending'
      and start_lease_owner = p_owner;
$$;

-- 첫 타석 창 지남 → suppressed 강제 전이(idle 또는 lease 만료 sending 만; 유효 sending 은
-- 발송 중이므로 건드리지 않는다). start_notified=true 로 read-compat 보존(종료알림·LA wake).
create or replace function suppress_start(
  p_game_id text,
  p_reason text
) returns void
language sql
set search_path = public
as $$
  update game_notify_state
    set start_state = 'suppressed',
        start_suppressed_reason = p_reason,
        start_notified = true,
        start_lease_until = null,
        start_lease_owner = null,
        updated_at = now()
    where game_id = p_game_id
      and (
        start_state = 'idle'
        or (start_state = 'sending' and start_lease_until < now())
      );
$$;

revoke all on function claim_start_lease(text, text, int) from anon, authenticated, public;
revoke all on function mark_start_sent(text, text) from anon, authenticated, public;
revoke all on function release_start_lease(text, text) from anon, authenticated, public;
revoke all on function suppress_start(text, text) from anon, authenticated, public;
grant execute on function claim_start_lease(text, text, int) to service_role;
grant execute on function mark_start_sent(text, text) to service_role;
grant execute on function release_start_lease(text, text) to service_role;
grant execute on function suppress_start(text, text) to service_role;
