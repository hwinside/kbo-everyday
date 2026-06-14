-- Live Activity W3b — push-to-start 토큰 + 게임별 자동시작 1회 선점 마커.
-- 앱 미실행 상태에서 서버가 Activity를 *시작*시키는 디바이스 단위 토큰(iOS 17.2+).
-- 최애팀 경기 시작 시 이 토큰으로 APNs event:start 푸시 → 잠금화면 카드 자동 표시.
-- 이후 갱신은 W3a(live_activity_tokens) 경로.

create table if not exists public.live_activity_start_tokens (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  push_to_start_token  text not null,
  updated_at           timestamptz not null default now()
);

-- RLS: 본인 토큰만 등록/갱신/삭제. 서버 발송은 service_role(RLS 우회).
alter table public.live_activity_start_tokens enable row level security;

drop policy if exists "own la start token insert" on public.live_activity_start_tokens;
create policy "own la start token insert"
  on public.live_activity_start_tokens for insert
  to authenticated with check (auth.uid() = user_id);

drop policy if exists "own la start token update" on public.live_activity_start_tokens;
create policy "own la start token update"
  on public.live_activity_start_tokens for update
  to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own la start token delete" on public.live_activity_start_tokens;
create policy "own la start token delete"
  on public.live_activity_start_tokens for delete
  to authenticated using (auth.uid() = user_id);

-- 게임 단위 push-to-start 1회 선점 마커. insert 성공한 cron 호출만 자동시작 발송
-- (다중 인스턴스 동시 실행에도 게임당 1회). 서버 service_role 전용(정책 없음 = 클라 접근 차단).
create table if not exists public.live_activity_started (
  game_id     text primary key,
  created_at  timestamptz not null default now()
);

alter table public.live_activity_started enable row level security;
