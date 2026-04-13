CREATE TABLE IF NOT EXISTS public.admin_auth_attempts (
  ip_address text PRIMARY KEY,
  failed_attempts integer NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  last_failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_auth_attempts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_admin_auth_attempts_blocked_until
  ON public.admin_auth_attempts (blocked_until);
