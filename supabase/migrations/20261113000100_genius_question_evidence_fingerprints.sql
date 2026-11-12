ALTER TABLE public.genius_question_logs
  ADD COLUMN IF NOT EXISTS rag_evidence_fingerprints jsonb;
-- Reapplying the migration must preserve existing observations and constraints.
DO $$
BEGIN
IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'public.genius_question_logs'::regclass
    AND conname = 'genius_question_logs_evidence_fingerprints_array'
) THEN
ALTER TABLE public.genius_question_logs
  ADD CONSTRAINT genius_question_logs_evidence_fingerprints_array CHECK (
    rag_evidence_fingerprints IS NULL OR
    (jsonb_typeof(rag_evidence_fingerprints) = 'array'
      AND jsonb_array_length(rag_evidence_fingerprints) <= 50)
  );
END IF;
END;
$$;
COMMENT ON COLUMN public.genius_question_logs.rag_evidence_fingerprints IS
  'Selected official evidence in order: chunk ID, raw content SHA256, effective content SHA256. No passage text or numeric claim values. NULL means unobserved/legacy; not historical reconstruction.';
