-- Deploy prerequisite: expand CHECK before deploying the new application reason.
-- Preserves existing rows and every previously accepted reason.
BEGIN;
alter table genius_question_logs
  drop constraint if exists genius_question_logs_rag_discard_reason_check;
alter table genius_question_logs
  add constraint genius_question_logs_rag_discard_reason_check
  check (
    rag_discard_reason is null
    or rag_discard_reason in (
      'malformed_json',
      'model_insufficient',
      'missing_answer',
      'empty_answer',
      'too_long',
      'unsafe_output',
      'unknown_status',
      'numeric_claim_ungrounded',
      'numeric_not_in_evidence',
      'numeric_not_in_question',
      'event_date_unverified'
    )
  );
COMMIT;
