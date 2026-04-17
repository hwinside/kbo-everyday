-- B안: YouTube quota 의존도 제거 & Cloud-native cron
-- 관련 스펙: specs/youtube-quota-b안.md
-- Phase 0: videos 테이블 신규 + 관련 인덱스

create table if not exists videos (
  id bigserial primary key,
  video_id text not null unique,
  team_id text not null,
  player_id text,                                 -- players_roster.kbo_id (nullable)
  title text not null,
  channel text,
  channel_id text,                                -- 공식채널 구분용
  thumbnail text,
  published_at timestamptz not null,
  duration_seconds int,                           -- RSS는 NULL 가능
  source_type text not null
    check (source_type in ('official_long', 'official_short', 'player', 'team_search')),
  is_short_candidate boolean not null default false,
  noise_flags jsonb not null default '[]'::jsonb, -- ['highlight_compilation','fancam','vlog','ceremony']
  fetched_at timestamptz not null default now()
);

-- 팀 + source_type + 최신순 조회 (런타임 API 핵심 쿼리)
create index if not exists idx_videos_team_source
  on videos(team_id, source_type, published_at desc);

-- 최애선수 기반 조회
create index if not exists idx_videos_player
  on videos(player_id, published_at desc)
  where player_id is not null;

-- 숏츠 후보 전역 조회
create index if not exists idx_videos_shorts
  on videos(is_short_candidate, published_at desc)
  where is_short_candidate = true;

-- fetched_at 기반 stale 데이터 정리용
create index if not exists idx_videos_fetched
  on videos(fetched_at);

-- RLS: 공개 읽기, 서비스 롤만 쓰기
alter table videos enable row level security;

drop policy if exists "videos_public_read" on videos;
create policy "videos_public_read"
  on videos for select
  using (true);

drop policy if exists "videos_service_write" on videos;
create policy "videos_service_write"
  on videos for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table videos is 'YouTube 영상 SSOT — cron이 채우고 런타임 API는 SELECT만. B안 기반.';
comment on column videos.source_type is 'official_long|official_short|player|team_search';
comment on column videos.noise_flags is 'highlight_compilation|fancam|vlog|ceremony 등 노이즈 태그';
