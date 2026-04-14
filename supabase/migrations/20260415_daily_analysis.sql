-- Daily AI Analysis: 순위 스냅샷 + 스탯 스냅샷 + 분석 결과

-- 1. 날짜별 팀 순위 스냅샷
create table if not exists daily_standings_snapshot (
  date        date    not null,
  team_id     int     not null,
  rank        int     not null,
  wins        int     not null,
  losses      int     not null,
  draws       int     not null,
  win_rate    float   not null,
  games_behind float  not null,
  streak      text,  -- e.g. '3연승', '2연패'
  primary key (date, team_id)
);

alter table daily_standings_snapshot enable row level security;
create policy "public read daily_standings_snapshot"
  on daily_standings_snapshot for select to anon, authenticated using (true);

-- 2. 날짜별 타이틀 상위 10명 스냅샷
create table if not exists daily_stats_snapshot (
  date          date    not null,
  category      text    not null, -- 'avg','hr','rbi','sb','era','wins','k','saves','whip'
  rank          int     not null,
  player_name   text    not null,
  team          text    not null,
  value         float   not null,
  primary key (date, category, rank)
);

alter table daily_stats_snapshot enable row level security;
create policy "public read daily_stats_snapshot"
  on daily_stats_snapshot for select to anon, authenticated using (true);

-- 3. 최종 분석 결과
create table if not exists daily_analysis (
  date            date        not null,
  type            text        not null, -- 'standings' | 'batter_titles' | 'pitcher_titles'
  delta_json      jsonb,
  generated_copy  text,
  prompt_version  int         not null default 1,
  created_at      timestamptz not null default now(),
  primary key (date, type)
);

alter table daily_analysis enable row level security;
create policy "public read daily_analysis"
  on daily_analysis for select to anon, authenticated using (true);
