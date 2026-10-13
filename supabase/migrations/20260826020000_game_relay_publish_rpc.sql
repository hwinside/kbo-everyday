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
-- 반환: jsonb { result: 'lock_busy'|'stale'|'inserted', id: bigint|null } (삼순 P1)
--   result = 명시 결과, id = inserted 시 frame DB id(관측·디버깅). stale/lock_busy 는 null.
-- security invoker: 호출자(service_role) 권한으로 실행 → RLS 우회 INSERT 는
--   service_role 자격에서만 성립. anon/authenticated 는 테이블 write 권한이 없어
--   설령 호출해도 permission denied. 추가로 EXECUTE 를 PUBLIC 에서 revoke.
-- set search_path = '': 스키마 하이재킹 차단, 모든 참조 schema-qualified.
-- channel 은 파라미터로 받지 않고 p_kind 에서 DB 가 유도한다(삼순 P1): 클라가 kind 와
--   불일치하는 channel 을 넣어 cursor 를 오염시키는 경로를 원천 차단(단일 근원 = DB).
create function public.publish_relay_frame(
  p_game_id text,
  p_kind    text,
  p_epoch   bigint,
  p_ordinal bigint,
  p_seq     bigint,
  p_payload jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_channel text;
  v_epoch   bigint;
  v_ordinal bigint;
  v_id      bigint;
begin
  -- p_kind 에서 channel 유도 (relay-full/relay-delta → 'relay', 그 외엔 kind===channel).
  v_channel := case
    when p_kind in ('relay-full', 'relay-delta') then 'relay'
    else p_kind
  end;

  -- ① 경기 단위 비차단 락. 실패 = 다른 인보케이션이 이 경기를 쓰는 중 → 즉시 양보.
  --   2-int 네임스페이싱(삼순 P1): relay 전용 classid + game objid 로, 다른 기능의
  --   단일-int advisory lock 과 해시 충돌하지 않게 격리한다.
  if not pg_try_advisory_xact_lock(hashtext('kbo_relay_publish'), hashtext(p_game_id)) then
    return jsonb_build_object('result', 'lock_busy', 'id', null);
  end if;

  -- ② durable cursor 잠금 조회 (같은 트랜잭션 내 직렬화)
  select epoch, ordinal into v_epoch, v_ordinal
    from public.game_relay_cursor
    where game_id = p_game_id and channel = v_channel
    for update;

  if found then
    -- (epoch, ordinal) <= cursor → stale, 원자 거부
    if p_epoch < v_epoch
       or (p_epoch = v_epoch and p_ordinal <= v_ordinal) then
      return jsonb_build_object('result', 'stale', 'id', null);
    end if;
    update public.game_relay_cursor
      set epoch = p_epoch, ordinal = p_ordinal, updated_at = now()
      where game_id = p_game_id and channel = v_channel;
  else
    insert into public.game_relay_cursor (game_id, channel, epoch, ordinal)
      values (p_game_id, v_channel, p_epoch, p_ordinal);
  end if;

  -- ③ cursor 갱신과 같은 트랜잭션에서 frame INSERT → id/commit 순서 직렬화
  insert into public.game_relay_frames (game_id, seq, kind, channel, epoch, ordinal, payload)
    values (p_game_id, p_seq, p_kind, v_channel, p_epoch, p_ordinal, p_payload)
    returning id into v_id;

  return jsonb_build_object('result', 'inserted', 'id', v_id);
end;
$$;

-- EXECUTE 는 service_role(수집기)만. PUBLIC 기본 grant 회수.
revoke execute on function public.publish_relay_frame(text, text, bigint, bigint, bigint, jsonb) from public;
grant execute on function public.publish_relay_frame(text, text, bigint, bigint, bigint, jsonb) to service_role;

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

-- ⚠️ 삼순 P0(실배포 장애 요인): reserve_relay_epoch 는 security invoker 라 nextval 실행에
--   호출자(service_role)의 sequence USAGE 권한이 필요하다. 이 grant 가 없으면 매 분
--   크론이 reserve_relay_epoch 에서 permission denied → route 가 503 으로 인보케이션
--   전체를 죽여 relay 퍼블리셔가 100% 실패한다.
grant usage on sequence public.game_relay_epoch_seq to service_role;
