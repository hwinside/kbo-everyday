-- 크관 relay 폴링 → Supabase Realtime 이관 (B안, 2026-08-25 하린아빠 착수 지시)
--
-- 목적: KgwanTab의 3초 Vercel 폴링(/api/game-relay-events, ~29M req/월)을
-- postgres_changes INSERT 구독으로 대체해 라이브 relay 데이터 경로에서 Vercel
-- edge request를 제거한다. 채팅(chat_messages)과 동일한 패턴:
--   - write는 service_role(수집기 cron)만 → 클라이언트 스푸핑 원리적 불가
--   - 클라이언트는 SELECT(초기 로드·self-heal)와 Realtime INSERT 구독만
--
-- 페이로드 계약: payload는 기존 NDJSON 스트림의 LivePollEnvelope와 동일 형상
-- ({channel, ok, status, data}). 클라이언트는 폴링 경로와 같은 병합 코드를 태운다.

create table public.game_relay_frames (
  id bigint generated always as identity primary key,
  game_id text not null,
  -- 수집기 발급 단조증가 seq (경기·채널 단위). 클라이언트는 id(전역 단조)로
  -- 순서를 판정하고 seq는 진단·중복검출 보조로 쓴다.
  seq bigint not null,
  -- LivePollEnvelope.channel + full/delta 구분
  kind text not null check (kind in ('relay-full', 'relay-delta', 'events', 'live', 'detail')),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.game_relay_frames is
  '크관 라이브 relay 프레임 (수집기 cron write-only, 클라이언트 read+realtime 구독). 보존은 수집기가 24h GC.';

-- 조회 패턴: ①mount 시 game_id의 최신 relay-full 1건 + 그 이후 delta들 ②realtime catch-up
create index game_relay_frames_game_id_id_desc_idx
  on public.game_relay_frames (game_id, id desc);
-- GC 패턴: created_at < now() - interval '24 hours'
create index game_relay_frames_created_at_idx
  on public.game_relay_frames (created_at);

alter table public.game_relay_frames enable row level security;

-- 읽기: 전원(비로그인 포함 — relay는 공개 데이터, 크관은 로그인 없이 접근 가능)
create policy "game_relay_frames_select_all"
  on public.game_relay_frames for select
  to anon, authenticated
  using (true);

-- INSERT/UPDATE/DELETE 정책 없음 = service_role(수집기)만 쓴다.

-- Realtime: INSERT 이벤트를 postgres_changes로 전파 (chat_messages와 동일)
alter publication supabase_realtime add table public.game_relay_frames;
