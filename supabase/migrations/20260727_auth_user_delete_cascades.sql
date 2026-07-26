-- Account deletion must be atomic from auth.users.
--
-- Existing NO ACTION foreign keys caused GoTrue deleteUser to fail after the
-- API route had already deleted profiles. That left signed-in zombie accounts
-- and retried the same 500 error hundreds of times.

ALTER TABLE public.admin_page_views
  DROP CONSTRAINT admin_page_views_user_id_fkey,
  ADD CONSTRAINT admin_page_views_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE SET NULL;

ALTER TABLE public.dm_conversations
  DROP CONSTRAINT dm_conversations_user1_id_fkey,
  DROP CONSTRAINT dm_conversations_user2_id_fkey,
  ADD CONSTRAINT dm_conversations_user1_id_fkey
    FOREIGN KEY (user1_id) REFERENCES auth.users (id) ON DELETE CASCADE,
  ADD CONSTRAINT dm_conversations_user2_id_fkey
    FOREIGN KEY (user2_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.dm_messages
  DROP CONSTRAINT dm_messages_sender_id_fkey,
  ADD CONSTRAINT dm_messages_sender_id_fkey
    FOREIGN KEY (sender_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.dm_reports
  DROP CONSTRAINT dm_reports_conversation_id_fkey,
  DROP CONSTRAINT dm_reports_reporter_id_fkey,
  DROP CONSTRAINT dm_reports_reported_user_id_fkey,
  ADD CONSTRAINT dm_reports_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES public.dm_conversations (id) ON DELETE CASCADE,
  ADD CONSTRAINT dm_reports_reporter_id_fkey
    FOREIGN KEY (reporter_id) REFERENCES auth.users (id) ON DELETE CASCADE,
  ADD CONSTRAINT dm_reports_reported_user_id_fkey
    FOREIGN KEY (reported_user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.feedback
  DROP CONSTRAINT feedback_user_id_fkey,
  ADD CONSTRAINT feedback_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.feedback_votes
  DROP CONSTRAINT feedback_votes_user_id_fkey,
  ADD CONSTRAINT feedback_votes_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.invitations
  DROP CONSTRAINT invitations_invitee_id_fkey,
  DROP CONSTRAINT invitations_inviter_id_fkey,
  ADD CONSTRAINT invitations_invitee_id_fkey
    FOREIGN KEY (invitee_id) REFERENCES public.profiles (id) ON DELETE SET NULL,
  ADD CONSTRAINT invitations_inviter_id_fkey
    FOREIGN KEY (inviter_id) REFERENCES public.profiles (id) ON DELETE SET NULL;

ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_invited_by_fkey,
  ADD CONSTRAINT profiles_invited_by_fkey
    FOREIGN KEY (invited_by) REFERENCES public.profiles (id) ON DELETE SET NULL;

ALTER TABLE public.reports
  DROP CONSTRAINT reports_reporter_id_fkey,
  ADD CONSTRAINT reports_reporter_id_fkey
    FOREIGN KEY (reporter_id) REFERENCES public.profiles (id) ON DELETE SET NULL;

ALTER TABLE public.user_blocks
  DROP CONSTRAINT user_blocks_blocker_id_fkey,
  DROP CONSTRAINT user_blocks_blocked_id_fkey,
  ADD CONSTRAINT user_blocks_blocker_id_fkey
    FOREIGN KEY (blocker_id) REFERENCES auth.users (id) ON DELETE CASCADE,
  ADD CONSTRAINT user_blocks_blocked_id_fkey
    FOREIGN KEY (blocked_id) REFERENCES auth.users (id) ON DELETE CASCADE;
