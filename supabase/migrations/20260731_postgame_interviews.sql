-- 종료 경기별 수훈선수 인터뷰 후속 탐색.
-- 작업 상태는 service_role 크론 전용, 확정된 고신뢰 영상만 공개 읽기 허용.

create table if not exists postgame_interview_jobs (
  game_id text primary key,
  game_date date not null,
  away_team_id integer not null,
  home_team_id integer not null,
  winner_team_id integer not null,
  -- 당일 전체 일정(종료 여부 무관)의 동일 대진 수로 seed 시점에 확정해 영속한다.
  is_doubleheader boolean not null default false,
  ended_at timestamptz not null,
  collect_after timestamptz not null,
  expires_at timestamptz not null,
  next_collect_at timestamptz not null,
  attempts integer not null default 0,
  status text not null default 'collecting'
    check (status in ('collecting', 'expired')),
  last_collected_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (collect_after >= ended_at + interval '30 minutes'),
  check (expires_at = ended_at + interval '24 hours')
);

create index if not exists idx_postgame_interview_jobs_due
  on postgame_interview_jobs (next_collect_at, expires_at)
  where status = 'collecting';

alter table postgame_interview_jobs enable row level security;
-- 정책 없음: service_role만 접근.

create table if not exists postgame_interviews (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references postgame_interview_jobs(game_id) on delete cascade,
  video_id text not null,
  title text not null,
  channel text not null,
  channel_id text not null,
  thumbnail text,
  published_at timestamptz not null,
  player_names text[] not null default '{}',
  source_kind text not null check (source_kind in ('broadcaster', 'team')),
  confidence text not null default 'high' check (confidence = 'high'),
  created_at timestamptz not null default now(),
  unique (game_id, video_id)
);

create index if not exists idx_postgame_interviews_game
  on postgame_interviews (game_id, published_at);

alter table postgame_interviews enable row level security;

drop policy if exists "postgame interviews public read" on postgame_interviews;
create policy "postgame interviews public read"
  on postgame_interviews for select
  to anon, authenticated
  using (confidence = 'high');

grant select on postgame_interviews to anon, authenticated;
revoke insert, update, delete on postgame_interviews from anon, authenticated;
