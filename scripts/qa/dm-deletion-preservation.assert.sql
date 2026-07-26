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

  -- Admin inbox keeps anonymized senders in its "not system" unread contract.
  ASSERT public.admin_dm_unread_total(u2) = 1,
    'anonymous departed sender was omitted from admin unread total';
  ASSERT EXISTS (
    SELECT 1
    FROM public.admin_dm_inbox_page(u2, NULL, NULL, 51) inbox
    WHERE inbox.id = conv
      AND inbox.other_user_id IS NULL
      AND inbox.other_nickname = '탈퇴한 사용자'
      AND inbox.unread_count = 1
      AND inbox.user_msg_count = 1
  ), 'admin inbox did not preserve nullable other user/unread contract';

  -- Pass test identities to the authenticated-role phase below.
  PERFORM set_config('test.dm_survivor_id', u2::text, true);
  PERFORM set_config('test.dm_conversation_id', conv::text, true);

  RAISE NOTICE 'DM deletion preservation: ALL ASSERTS PASSED';
END $$;

-- Exercise the real authenticated RLS path as the surviving account.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  current_setting('test.dm_survivor_id'),
  true
);

DO $$
DECLARE
  survivor uuid := current_setting('test.dm_survivor_id')::uuid;
  conv uuid := current_setting('test.dm_conversation_id')::uuid;
BEGIN
  ASSERT auth.uid() = survivor, 'authenticated test identity was not installed';
  ASSERT (SELECT count(*) FROM public.dm_conversations WHERE id = conv) = 1,
    'surviving participant cannot read preserved conversation through RLS';
  ASSERT (SELECT count(*) FROM public.dm_messages WHERE conversation_id = conv) = 2,
    'surviving participant cannot read preserved messages through RLS';
  ASSERT (SELECT count(*) FROM public.dm_reports WHERE conversation_id = conv) = 1,
    'surviving reporter cannot read preserved report through RLS';

  -- NULL sender means "not me"; it must be markable as read by the survivor.
  ASSERT (
    SELECT count(*)
    FROM public.dm_messages
    WHERE conversation_id = conv
      AND sender_id IS DISTINCT FROM auth.uid()
      AND is_read = FALSE
  ) = 1, 'anonymous unread message was omitted';
  ASSERT (
    SELECT unread_count
    FROM public.dm_unread_counts(ARRAY[conv])
    WHERE conversation_id = conv
  ) = 1, 'authenticated unread RPC omitted anonymous sender';

  BEGIN
    PERFORM 1
    FROM public.dm_unread_counts(
      ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 501))
    );
    RAISE EXCEPTION 'dm_unread_counts accepted more than 500 ids';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      NULL;
  END;

  UPDATE public.dm_messages
  SET is_read = TRUE
  WHERE conversation_id = conv
    AND sender_id IS DISTINCT FROM auth.uid()
    AND is_read = FALSE;
  ASSERT (
    SELECT count(*)
    FROM public.dm_messages
    WHERE conversation_id = conv
      AND sender_id IS DISTINCT FROM auth.uid()
      AND is_read = FALSE
  ) = 0, 'surviving participant could not mark anonymous message read';

  -- Preserved one-participant conversations are evidence-only/read-only.
  BEGIN
    INSERT INTO public.dm_messages (conversation_id, sender_id, content)
    VALUES (conv, survivor, 'must be rejected');
    RAISE EXCEPTION 'new message was allowed in departed conversation';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END $$;

RESET ROLE;
