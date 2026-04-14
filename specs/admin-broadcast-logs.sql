-- admin_broadcast_logs: 전체/팀별 쪽지 발송 기록
CREATE TABLE IF NOT EXISTS admin_broadcast_logs (
  id bigint generated always as identity primary key,
  content text NOT NULL,
  target_label text NOT NULL,           -- "전체" or "LG, 두산" etc
  target_team_ids integer[] DEFAULT NULL, -- null = 전체
  total_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  fail_count integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_abl_created ON admin_broadcast_logs(created_at DESC);
