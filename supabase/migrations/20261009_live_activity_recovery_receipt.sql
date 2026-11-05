-- Additive diagnostics; no changes to restart eligibility, one-shot claim, ACK or RLS.
-- Existing rows deliberately remain NULL: a historical restart is not an APNs receipt.
alter table public.live_activity_device_recovery
  add column restart_apns_outcome text check (restart_apns_outcome in ('accepted','rejected','unknown')),
  add column restart_apns_status integer,
  add column restart_apns_reason text,
  add column restart_apns_id text,
  add column restart_apns_recorded_at timestamptz,
  add constraint live_activity_recovery_receipt_valid check (
    (restart_apns_outcome is null and restart_apns_status is null and restart_apns_reason is null
      and restart_apns_id is null and restart_apns_recorded_at is null)
    or (restart_apns_outcome is not null and restart_apns_status is not null
      and restart_at is not null and restart_apns_recorded_at is not null
      and ((restart_apns_outcome = 'accepted' and restart_apns_status = 200)
        or (restart_apns_outcome = 'rejected' and restart_apns_status between 100 and 599 and restart_apns_status <> 200)
        or (restart_apns_outcome = 'unknown' and restart_apns_status = 0)))
  );
comment on column public.live_activity_device_recovery.restart_apns_outcome is
  'APNs restart receipt, never device display. NULL=not durably observed; unknown=no HTTP response. Does not authorize retry.';
