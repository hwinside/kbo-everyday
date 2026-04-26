-- Shorts Aggregator: channel_pool + videos extensions
-- Spec: specs/shorts-aggregator.md

-- 1. channel_pool table
create table if not exists channel_pool (
  channel_id text primary key,
  channel_name text not null,
  tier int not null default 3
    check (tier between 1 and 4),
  subscriber_count int,
  is_active boolean not null default true,
  team_affinity text[],
  last_video_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table channel_pool is '숏츠 소싱용 YouTube 채널 풀 — 공식+비공식 통합';
comment on column channel_pool.tier is '1=방송사/공식, 2=인기유튜버, 3=팬채널, 4=기타';
comment on column channel_pool.team_affinity is '연관 팀 shortName 배열 (nullable=범용)';

create index if not exists idx_channel_pool_active
  on channel_pool(is_active, tier)
  where is_active = true;

alter table channel_pool enable row level security;

create policy "channel_pool_public_read"
  on channel_pool for select using (true);

create policy "channel_pool_service_write"
  on channel_pool for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- 2. Extend videos.source_type to include community types
alter table videos drop constraint if exists videos_source_type_check;
alter table videos add constraint videos_source_type_check
  check (source_type in (
    'official_long', 'official_short',
    'player', 'team_search',
    'community_short', 'community_long'
  ));

-- 3. Add player_ids array for multi-player tagging
alter table videos add column if not exists player_ids text[] default '{}';

create index if not exists idx_videos_player_ids
  on videos using gin (player_ids)
  where array_length(player_ids, 1) > 0;

-- 4. Add aliases column to players_roster for auto-tagging
alter table players_roster add column if not exists aliases text[] default '{}';
