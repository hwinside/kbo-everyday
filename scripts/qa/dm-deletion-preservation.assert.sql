-- Shared-evidence preservation on account deletion.
--
-- Asserts that deleting one participant anonymizes their identity (SET NULL)
-- but preserves the OTHER party's conversation + messages and the abuse-report
-- evidence. Seeds/deletes inside the caller's transaction; the runner wraps
-- this with the FK migration + ROLLBACK so nothing touches production data.
DO $$
DECLARE
  u1 uuid := gen_random_uuid();  -- departing account
  u2 uuid := gen_random_uuid();  -- other party (must keep their history)
  conv uuid;
BEGIN
  INSERT INTO auth.users (id) VALUES (u1), (u2);

  INSERT INTO public.dm_conversations (user1_id, user2_id)
    VALUES (u1, u2) RETURNING id INTO conv;

  INSERT INTO public.dm_messages (conversation_id, sender_id, content) VALUES
    (conv, u1, 'msg from departing user'),
    (conv, u2, 'msg from the other party');

  INSERT INTO public.dm_reports (reporter_id, reported_user_id, conversation_id, reason)
    VALUES (u2, u1, conv, 'abuse evidence that must survive');

  -- Simulate GoTrue deleteUser (auth.users row removal fires the FKs).
  DELETE FROM auth.users WHERE id = u1;

  -- Conversation survives, departed identity anonymized, other party intact.
  ASSERT (SELECT count(*) FROM public.dm_conversations WHERE id = conv) = 1,
    'conversation was deleted (should be preserved)';
  ASSERT (SELECT user1_id FROM public.dm_conversations WHERE id = conv) IS NULL,
    'departed user1_id not anonymized';
  ASSERT (SELECT user2_id FROM public.dm_conversations WHERE id = conv) = u2,
    'other party user2_id lost';

  -- Both messages survive; only the departed sender is anonymized.
  ASSERT (SELECT count(*) FROM public.dm_messages WHERE conversation_id = conv) = 2,
    'messages were deleted (should be preserved)';
  ASSERT (SELECT count(*) FROM public.dm_messages WHERE conversation_id = conv AND sender_id IS NULL) = 1,
    'departed sender not anonymized';
  ASSERT (SELECT count(*) FROM public.dm_messages WHERE conversation_id = conv AND sender_id = u2) = 1,
    'other party message lost';

  -- Abuse report evidence survives with the departed identity anonymized.
  ASSERT (SELECT count(*) FROM public.dm_reports WHERE conversation_id = conv) = 1,
    'abuse report was deleted (evidence lost)';
  ASSERT (SELECT reported_user_id FROM public.dm_reports WHERE conversation_id = conv) IS NULL,
    'reported (departed) identity not anonymized';
  ASSERT (SELECT reporter_id FROM public.dm_reports WHERE conversation_id = conv) = u2,
    'reporter identity lost';

  RAISE NOTICE 'DM deletion preservation: ALL ASSERTS PASSED';
END $$;
