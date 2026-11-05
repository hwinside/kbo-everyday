-- Observation only: no route, prompt, RLS or response-policy changes.
-- query-guard: DDL only, nullable additive columns; no production row scan/backfill.
ALTER TABLE public.genius_question_logs
  ADD COLUMN IF NOT EXISTS stat_intent_mode boolean,
  ADD COLUMN IF NOT EXISTS context_selected boolean,
  ADD COLUMN IF NOT EXISTS provider_outcome text,
  ADD COLUMN IF NOT EXISTS classifier_observation jsonb;
ALTER TABLE public.genius_question_jobs
  ADD COLUMN IF NOT EXISTS classifier_observation jsonb;
COMMENT ON COLUMN public.genius_question_logs.stat_intent_mode IS
  'Observed answer-generating call used stat intent mode. NULL means unknown (legacy replay); not a guard replay estimate.';
COMMENT ON COLUMN public.genius_question_logs.context_selected IS
  'Production global context selector after injection filtering; NULL means not reached/legacy. Not proof the model used context.';
COMMENT ON COLUMN public.genius_question_logs.provider_outcome IS
  'Last answer-generating generic/RAG provider call: not_called,ok,timeout,http_5xx,http_error,provider_error,legacy_unknown. Excludes mapper/embedding calls; not parser validity.';
COMMENT ON COLUMN public.genius_question_jobs.classifier_observation IS
  'Versioned non-text observation atomically persisted with llm_text for retry replay. No raw model/error text or identities.';
