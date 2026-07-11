-- Client-side error telemetry. Until now an uncaught client exception showed
-- Next.js' default "Application error" screen and left no trace anywhere, so
-- intermittent user reports (2026-07-11 #cs) couldn't be root-caused. The
-- browser reports errors to /api/telemetry/client-error which inserts here
-- with service_role (RLS on + zero policies = deny all non-service access).

CREATE TABLE IF NOT EXISTS admin_client_errors (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  message        text        NOT NULL,
  stack          text,
  source         text        NOT NULL, -- window-error | unhandledrejection | error-boundary | global-error-boundary
  digest         text,                 -- Next.js server-error digest, when present
  path           text,
  platform       text,                 -- ios_native | android_native | pwa | web
  app_version    text,                 -- native "1.0.8 (12)" or null
  user_agent     text,
  visitor_id     text,
  is_chunk_error boolean     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_client_errors_created
  ON admin_client_errors (created_at);

ALTER TABLE admin_client_errors ENABLE ROW LEVEL SECURITY;
