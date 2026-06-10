-- 푸시 알림 v1 — S3: INSERT → 디스패처 webhook 트리거 (pg_net)
-- comments / dm_messages / posts INSERT 시 /api/notifications/dispatch로 POST.
-- url/secret은 DB GUC로 주입 (repo에 비노출):
--   ALTER DATABASE postgres SET app.push_dispatch_url = 'https://keubo.fan/api/notifications/dispatch';
--   ALTER DATABASE postgres SET app.push_dispatch_secret = '<random>';
-- GUC 미설정 시 트리거는 조용히 no-op (fail-open — insert 자체를 막지 않음)

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION notify_push_dispatch()
RETURNS TRIGGER AS $$
DECLARE
  dispatch_url text := current_setting('app.push_dispatch_url', true);
  dispatch_secret text := current_setting('app.push_dispatch_secret', true);
BEGIN
  IF dispatch_url IS NULL OR dispatch_secret IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM net.http_post(
    url := dispatch_url,
    body := jsonb_build_object('table', TG_TABLE_NAME, 'record', to_jsonb(NEW)),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', dispatch_secret
    ),
    timeout_milliseconds := 5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 알림 발송 실패가 원본 INSERT를 막으면 안 됨
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS push_dispatch_on_comment ON comments;
CREATE TRIGGER push_dispatch_on_comment
  AFTER INSERT ON comments
  FOR EACH ROW EXECUTE FUNCTION notify_push_dispatch();

DROP TRIGGER IF EXISTS push_dispatch_on_dm ON dm_messages;
CREATE TRIGGER push_dispatch_on_dm
  AFTER INSERT ON dm_messages
  FOR EACH ROW EXECUTE FUNCTION notify_push_dispatch();

DROP TRIGGER IF EXISTS push_dispatch_on_post ON posts;
CREATE TRIGGER push_dispatch_on_post
  AFTER INSERT ON posts
  FOR EACH ROW EXECUTE FUNCTION notify_push_dispatch();
