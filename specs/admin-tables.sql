-- Admin Dashboard Tables
-- 크보 에브리데이 어드민 대시보드용 Supabase 테이블

-- 1. 페이지 뷰 트래킹
CREATE TABLE admin_page_views (
  id bigint generated always as identity primary key,
  visitor_id text NOT NULL,
  path text NOT NULL,
  referrer text,
  user_agent text,
  device text,
  user_id uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_apv_created ON admin_page_views(created_at);
CREATE INDEX idx_apv_visitor ON admin_page_views(visitor_id);
CREATE INDEX idx_apv_path ON admin_page_views(path);

-- 2. 일별 집계 통계
CREATE TABLE admin_daily_stats (
  date date PRIMARY KEY,
  uv integer DEFAULT 0,
  pv integer DEFAULT 0,
  new_users integer DEFAULT 0,
  posts integer DEFAULT 0,
  comments integer DEFAULT 0,
  photos integer DEFAULT 0,
  predictions integer DEFAULT 0
);

-- 3. 배치/크롤러 작업 로그
CREATE TABLE admin_job_logs (
  id bigint generated always as identity primary key,
  job_name text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  result_summary text,
  error_message text
);
CREATE INDEX idx_ajl_job ON admin_job_logs(job_name, started_at DESC);
CREATE INDEX idx_ajl_status ON admin_job_logs(status);

-- 4. 이상 감지 로그
CREATE TABLE admin_anomaly_logs (
  id bigint generated always as identity primary key,
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  message text NOT NULL,
  details jsonb,
  acknowledged boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_aal_created ON admin_anomaly_logs(created_at DESC);
CREATE INDEX idx_aal_unacked ON admin_anomaly_logs(acknowledged) WHERE acknowledged = false;

-- 5. 성능 메트릭
CREATE TABLE admin_perf_metrics (
  id bigint generated always as identity primary key,
  path text NOT NULL,
  metric_name text NOT NULL,
  value float NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_apm_created ON admin_perf_metrics(created_at);
CREATE INDEX idx_apm_metric ON admin_perf_metrics(metric_name, created_at);

-- 6. feedback 테이블에 어드민 컬럼 추가 (기존 테이블이 있다면)
-- ALTER TABLE feedback ADD COLUMN IF NOT EXISTS status text DEFAULT 'received';
-- ALTER TABLE feedback ADD COLUMN IF NOT EXISTS admin_note text;

-- RLS 정책 (필요 시)
-- ALTER TABLE admin_page_views ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE admin_daily_stats ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE admin_job_logs ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE admin_anomaly_logs ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE admin_perf_metrics ENABLE ROW LEVEL SECURITY;
