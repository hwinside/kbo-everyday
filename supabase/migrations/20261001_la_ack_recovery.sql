-- Bounded ACK-less recovery. Apply before deploying the reader/writer.
-- Separate from wake_attempted_at, which is existing observational history.
ALTER TABLE public.live_activity_started_users
  ADD COLUMN IF NOT EXISTS ack_recovery_attempted_at timestamptz;
COMMENT ON COLUMN public.live_activity_started_users.ack_recovery_attempted_at IS
  'At-most-once silent rescan claim for unconfirmed channel-born start; not delivery/display success';
