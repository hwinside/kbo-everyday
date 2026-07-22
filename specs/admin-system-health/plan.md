# Plan

1. Add a pure Prometheus text parser and health summarizer under `src/lib/admin/`.
2. Add an authenticated, force-dynamic `/api/admin/system-health` route that queries Supabase Metrics and Management Health in parallel.
3. Add an auto-refreshing read-only health section to `/admin/system`.
4. Add targeted regression tests and run lint, typecheck, build, and UI-level verification.
