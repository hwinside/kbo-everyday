-- 어드민 CPU counter 스냅샷 원장 (2026-08-21, 대시보드 즉시 표시)
-- Supabase 메트릭 scrape가 ~60초 주기라 브라우저가 baseline을 직접 만들려면
-- 첫 ~60초는 "측정 중"이 된다. 서버(1분 cron + health API)가 스냅샷을 적재해두면
-- 대시보드를 여는 즉시 직전 스냅샷과의 delta로 CPU busy%를 계산할 수 있다.
create table if not exists admin_metric_snapshots (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  fingerprint text not null,
  total_seconds double precision not null,
  idle_seconds double precision not null
);

create index if not exists admin_metric_snapshots_captured_at_idx
  on admin_metric_snapshots (captured_at desc);

-- service role 전용 (정책 없음 = anon/authenticated 접근 불가)
alter table admin_metric_snapshots enable row level security;
