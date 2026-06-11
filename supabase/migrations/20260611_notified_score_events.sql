-- 푸시 알림 v1 — S5a: 내 팀 득점 알림 발송 dedup (event 단위 SSOT)
-- warmup cron(매분)이 game-events의 run_scored/at_bat_homerun 이벤트를 보고,
-- event_id를 멱등 INSERT(ON CONFLICT DO NOTHING)에 성공한 호출만 발송 자격을 가짐.
-- event.id는 점수상태/타자 단위로 이미 고유(event-generator) → 다중 인스턴스 race-safe.

CREATE TABLE IF NOT EXISTS notified_score_events (
  event_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 오래된 행 정리용 (경기 종료 후 누적 방지). 보존은 운영에서 별도 정리.
CREATE INDEX IF NOT EXISTS idx_notified_score_events_created
  ON notified_score_events (created_at);

ALTER TABLE notified_score_events ENABLE ROW LEVEL SECURITY;
-- service_role(cron)만 사용 — 클라이언트 정책 없음 (default deny)
