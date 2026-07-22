# Tasks

- [x] Parse and summarize official Supabase Prometheus metrics.
- [x] Fetch Metrics and Management Health with bounded timeouts and partial failure handling.
- [x] Render overall state, service state, resource cards, and last-updated time.
- [x] Poll at 60-second intervals without exposing credentials.
- [x] Add regression tests for healthy, warning, critical, and malformed input.
- [x] Degrade partial-source failures and expose stale refresh failures in the UI.
- [x] Add route partial-failure and UI success-to-failure regressions.
- [x] Reject unrelated/partial Metrics payloads as healthy and cover aged timestamps in the UI.
- [x] Preserve critical precedence under missing metrics and aggregate up gauges with any-down semantics.
- [ ] Complete PR review and End-User QA gates.
