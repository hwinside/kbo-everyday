-- App store download (install) counts per platform per day.
-- Populated server-side by the sync-app-downloads cron (service_role); read by
-- the admin downloads card (service_role). RLS is enabled with NO policy on
-- purpose: only service_role should ever touch this table, so client roles are
-- denied by default. (cf. admin_page_views, where the missing policy was a bug
-- because clients DO write there — here it's intentional.)

CREATE TABLE IF NOT EXISTS app_downloads (
  platform   text NOT NULL,              -- 'ios' | 'android'
  date       date NOT NULL,
  units      integer NOT NULL DEFAULT 0, -- first-time downloads (App Units) that day
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, date)
);

ALTER TABLE app_downloads ENABLE ROW LEVEL SECURITY;
