-- Retention metrics: cohort retention, activation funnel, gameday revisit
-- metric_type으로 grain 분리

create table if not exists retention_metrics (
  id            bigint generated always as identity primary key,
  date          date        not null,
  metric_type   text        not null,          -- 'cohort' | 'funnel' | 'gameday'
  cohort_key    text        not null,          -- cohort: 가입 주차 (e.g. '2026-W15'), funnel: 'all', gameday: 가입 주차
  metric_key    text        not null,          -- cohort: 'D1','D7','D14','D30', funnel: 'signup','team_select','first_prediction','first_comment','first_chat', gameday: 'gd1','gd2','gd3'
  total         int         not null default 0,
  value         int         not null default 0,
  rate          float       not null default 0,
  created_at    timestamptz not null default now(),

  unique (date, metric_type, cohort_key, metric_key)
);

create index if not exists idx_retention_metrics_type_date
  on retention_metrics (metric_type, date desc);

create index if not exists idx_retention_metrics_cohort
  on retention_metrics (metric_type, cohort_key, date desc);

alter table retention_metrics enable row level security;

-- service_role bypasses RLS, but explicit policy ensures no silent lockout
-- if accessed via anon key by mistake. Write = service_role only (RLS bypass).
comment on table retention_metrics is 'Accessed exclusively via supabaseAdmin (service_role). RLS enabled as defense-in-depth; no anon/authenticated policy intentional.';
