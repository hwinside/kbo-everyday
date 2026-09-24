-- Keep score correction guard alerts distinct from upstream schema failures.
alter table public.api_fallback_events drop constraint if exists api_fallback_events_reason_check;
alter table public.api_fallback_events add constraint api_fallback_events_reason_check
  check (reason in ('timeout', 'http-error', 'schema-error', 'network-error', 'score-guard'));
