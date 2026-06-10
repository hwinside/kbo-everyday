-- 푸시 알림 v1 — S4: 경기 시작/종료 알림 상태 (중복 발화 방지 SSOT)
-- warmup cron(매분)이 게임 상태를 보고, 조건부 UPDATE 선점에 성공한 호출만 발송.

CREATE TABLE IF NOT EXISTS game_notify_state (
  game_id TEXT PRIMARY KEY,
  start_notified BOOLEAN NOT NULL DEFAULT false,
  end_notified BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE game_notify_state ENABLE ROW LEVEL SECURITY;
-- service_role(cron)만 사용 — 클라이언트 정책 없음 (default deny)

-- ─────────────────────────────────────────────────────────────
-- S3 drift 정정: prod의 notify_push_dispatch()는 private.push_dispatch_config
-- 테이블 버전으로 교체 적용됐는데(2026-06-10, ALTER DATABASE GUC가 cloud 권한
-- 거부라 전환) repo migration(20260610_push_dispatch_triggers.sql)은 GUC 버전
-- 으로 남아 있었음. 아래가 prod 실상태와 일치하는 정본.
-- ─────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE IF NOT EXISTS private.push_dispatch_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id), -- 단일 row
  url text NOT NULL,
  secret text NOT NULL
);
REVOKE ALL ON SCHEMA private FROM anon, authenticated, public;
REVOKE ALL ON private.push_dispatch_config FROM anon, authenticated, public;
-- config row는 배포 시 수동 주입 (repo에 secret 비노출):
--   INSERT INTO private.push_dispatch_config (id, url, secret) VALUES (true, '<url>', '<secret>')
--   ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, secret = EXCLUDED.secret;

CREATE OR REPLACE FUNCTION notify_push_dispatch()
RETURNS TRIGGER AS $$
DECLARE
  cfg record;
BEGIN
  SELECT url, secret INTO cfg FROM private.push_dispatch_config WHERE id = true;
  IF cfg IS NULL THEN
    RETURN NEW; -- config 없음 = no-op (발송 비활성)
  END IF;
  PERFORM net.http_post(
    url := cfg.url,
    body := jsonb_build_object('table', TG_TABLE_NAME, 'record', to_jsonb(NEW)),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', cfg.secret
    ),
    timeout_milliseconds := 5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 알림 발송 실패가 원본 INSERT를 막으면 안 됨
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
