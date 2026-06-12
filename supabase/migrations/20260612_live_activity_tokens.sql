-- Live Activity W3a — per-activity APNs push token 저장.
-- 클라가 경기룸 진입(또는 push-start)으로 Activity를 띄우면 ActivityKit이 push token을
-- 발급 → 서버에 등록. warmup cron이 스코어 변화 시 이 토큰들로 APNs liveactivity 업데이트.
-- UNIQUE(user_id, game_id): 한 유저-경기당 활성 Activity 1개(최신 토큰으로 upsert).

create table if not exists public.live_activity_tokens (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  game_id     text not null,
  push_token  text not null,
  updated_at  timestamptz not null default now(),
  unique (user_id, game_id)
);

create index if not exists live_activity_tokens_game_idx
  on public.live_activity_tokens (game_id);

-- RLS: 본인 토큰만 등록/삭제. 서버 발송은 service_role(RLS 우회).
alter table public.live_activity_tokens enable row level security;

drop policy if exists "own live activity tokens insert" on public.live_activity_tokens;
create policy "own live activity tokens insert"
  on public.live_activity_tokens for insert
  to authenticated with check (auth.uid() = user_id);

drop policy if exists "own live activity tokens update" on public.live_activity_tokens;
create policy "own live activity tokens update"
  on public.live_activity_tokens for update
  to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own live activity tokens delete" on public.live_activity_tokens;
create policy "own live activity tokens delete"
  on public.live_activity_tokens for delete
  to authenticated using (auth.uid() = user_id);
