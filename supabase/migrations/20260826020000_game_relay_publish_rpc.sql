-- 크관 relay B안 — durable ordering DB 계약 (삼순 2026-08-25 17:47 확정 설계 반영)
--
-- 배경: JS 레벨 abort fence(publishGameTick)로는 cross-invocation overlap 에서
-- durable ordering 을 보장할 수 없다(삼순 6차 NO-GO). timeout 된 인보케이션 A 의
-- INSERT 가 서버측에서 계속 진행돼 다음 인보케이션 B 보다 늦게 커밋되면, 늦은 A
-- row 가 더 큰 DB id 로 전파돼 클라이언트가 stale A 를 최신으로 적용한다.
--
-- 확정 설계: 경기별 직렬화 + stale 원자 거부를 **DB 트랜잭션 내부**로 옮긴다.
--   ① pg_try_advisory_xact_lock(game) 비차단 락 → 실패 시 'lock_busy' 즉시 반환
--   ② (game, channel) 별 durable cursor 와 (epoch, ordinal) 비교 → stale 원자 거부
--   ③ cursor 갱신 + frame INSERT 를 한 트랜잭션으로 → id/commit 순서 직렬화
--      (클라이언트는 현행 DB id 로 순서 판정 유지, seq 전환 불필요)
--
-- ⚠️ HOLD: 이 migration 은 아직 적용하지 않는다(#1305 설계 리뷰 대상). apply·merge·
--    deploy·cutover 전부 하린아빠 명시 승인 후.

-- ── frames 테이블에 순서 좌표 추가 (이중 방어용) ──────────────────────────────
-- 24h GC 로 사라지는 frames 와 달리 cursor 는 durable. frames 의 epoch/ordinal 은
-- 진단 + unique 보조 제약(같은 좌표 이중 발행 차단)용.
alter table public.game_relay_frames
  add column channel text,
  add column epoch   bigint,
  add column ordinal bigint;

-- ── durable cursor: (game_id, channel) 당 마지막으로 커밋된 (epoch, ordinal) ──
-- frames 의 max(seq) 를 커서로 쓰면 안 된다(GC 로 소실). 별도 durable 행으로 보관해
-- GC 이후에도 stale 거부가 계속 동작한다.
create table public.game_relay_cursor (
  game_id    text   not null,
  channel    text   not null check (channel in ('relay', 'events', 'live', 'detail')),
  epoch      bigint not null,
  ordinal    bigint not null,
  updated_at timestamptz not null default now(),
  primary key (game_id, channel)
);

comment on table public.game_relay_cursor is
  '크관 relay 경기·채널별 durable 발행 커서 (epoch, ordinal). frames 24h GC 후에도 stale 거부 유지.';

alter table public.game_relay_cursor enable row level security;
-- 정책 없음 = service_role(수집기)만 접근. RPC 는 security invoker 로 호출자 권한 사용.

-- unique 보조 제약: advisory lock 이 우회돼도 같은 (game, channel, epoch, ordinal)
-- frame 이 이중 커밋되는 것을 물리적으로 차단(삼순 요구 "이중 방어").
create unique index game_relay_frames_coord_uidx
  on public.game_relay_frames (game_id, channel, epoch, ordinal)
  where epoch is not null and ordinal is not null;

-- ── 원자 발행 RPC ─────────────────────────────────────────────────────────────
-- 반환: 'lock_busy' | 'stale' | 'inserted' (삼순 요구 명시 반환)
-- security invoker: 호출자(service_role) 권한으로 실행 → RLS 우회 INSERT 는
--   service_role 자격에서만 성립. anon/authenticated 는 테이블 write 권한이 없어
--   설령 호출해도 permission denied. 추가로 EXECUTE 를 PUBLIC 에서 revoke.
-- set search_path = '': 스키마 하이재킹 차단, 모든 참조 schema-qualified.
create function public.publish_relay_frame(
  p_game_id text,
  p_channel text,
  p_kind    text,
  p_epoch   bigint,
  p_ordinal bigint,
  p_seq     bigint,
  p_payload jsonb
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_epoch   bigint;
  v_ordinal bigint;
begin
  -- ① 경기 단위 비차단 락. 실패 = 다른 인보케이션이 이 경기를 쓰는 중 → 즉시 양보.
  if not pg_try_advisory_xact_lock(hashtext(p_game_id)) then
    return 'lock_busy';
  end if;

  -- ② durable cursor 잠금 조회 (같은 트랜잭션 내 직렬화)
  select epoch, ordinal into v_epoch, v_ordinal
    from public.game_relay_cursor
    where game_id = p_game_id and channel = p_channel
    for update;

  if found then
    -- (epoch, ordinal) <= cursor → stale, 원자 거부
    if p_epoch < v_epoch
       or (p_epoch = v_epoch and p_ordinal <= v_ordinal) then
      return 'stale';
    end if;
    update public.game_relay_cursor
      set epoch = p_epoch, ordinal = p_ordinal, updated_at = now()
      where game_id = p_game_id and channel = p_channel;
  else
    insert into public.game_relay_cursor (game_id, channel, epoch, ordinal)
      values (p_game_id, p_channel, p_epoch, p_ordinal);
  end if;

  -- ③ cursor 갱신과 같은 트랜잭션에서 frame INSERT → id/commit 순서 직렬화
  insert into public.game_relay_frames (game_id, seq, kind, channel, epoch, ordinal, payload)
    values (p_game_id, p_seq, p_kind, p_channel, p_epoch, p_ordinal, p_payload);

  return 'inserted';
end;
$$;

-- EXECUTE 는 service_role(수집기)만. PUBLIC 기본 grant 회수.
revoke execute on function public.publish_relay_frame(text, text, text, bigint, bigint, bigint, jsonb) from public;
grant execute on function public.publish_relay_frame(text, text, text, bigint, bigint, bigint, jsonb) to service_role;

-- ── writer epoch 선예약 ───────────────────────────────────────────────────────
-- 삼순 3-2 확정: seq 를 커밋 시 max+1 로 재계산하지 않는다(lease-loss 동률에서 역전).
-- 대신 각 cron 인보케이션이 시작 시 DB 단조 epoch 를 선예약하고, 그 인보케이션의
-- 모든 프레임이 이 epoch 를 싣는다. 나중 인보케이션은 항상 더 큰 epoch → RPC 가
-- (epoch, ordinal) 로 늦은 이전 인보케이션 프레임을 원자 거부한다(cursor.epoch 미만).
create sequence public.game_relay_epoch_seq as bigint;

comment on sequence public.game_relay_epoch_seq is
  '크관 relay 인보케이션 단조 epoch. 인보케이션당 1회 reserve_relay_epoch() 로 발급.';

create function public.reserve_relay_epoch() returns bigint
language sql
security invoker
set search_path = ''
as $$
  select nextval('public.game_relay_epoch_seq');
$$;

revoke execute on function public.reserve_relay_epoch() from public;
grant execute on function public.reserve_relay_epoch() to service_role;
