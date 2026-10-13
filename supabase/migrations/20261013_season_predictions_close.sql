-- Preserve existing picks and read access. Enforce closure even for old clients/direct REST.
BEGIN;
CREATE POLICY "season_predictions_2026_insert_deadline"
ON public.season_predictions AS RESTRICTIVE FOR INSERT
WITH CHECK (season <> 2026 OR now() < TIMESTAMPTZ '2026-10-13 00:00:00+09');
CREATE POLICY "season_predictions_2026_update_deadline"
ON public.season_predictions AS RESTRICTIVE FOR UPDATE
USING (season <> 2026 OR now() < TIMESTAMPTZ '2026-10-13 00:00:00+09')
WITH CHECK (season <> 2026 OR now() < TIMESTAMPTZ '2026-10-13 00:00:00+09');
COMMIT;
