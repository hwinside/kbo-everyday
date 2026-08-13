-- advisor 2단계-A rollback — initplan 67건을 baseline 원문 qual/with_check로 복원
-- 생성기: scripts/db/generate-advisor-step2-migration.py (수동 편집 금지)
-- 적용된 DB에서만 실행. migration chain 밖 파일 — supabase/migrations에 넣지 말 것.

SET lock_timeout = '5s';

ALTER POLICY "apv_insert_own" ON public.admin_page_views WITH CHECK ((user_id = auth.uid()));
ALTER POLICY "Service role full access on announcements" ON public.announcements USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
ALTER POLICY "Admin read access" ON public.api_fallback_events USING ((((auth.jwt() ->> 'role'::text) = 'admin'::text) OR ((auth.jwt() ->> 'role'::text) = 'service_role'::text)));
ALTER POLICY "Service role write access" ON public.api_fallback_events WITH CHECK (((auth.jwt() ->> 'role'::text) = 'service_role'::text));
ALTER POLICY "cdc_service_all" ON public.channel_discovery_candidates USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
ALTER POLICY "cdl_service_all" ON public.channel_discovery_lock USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
ALTER POLICY "cdr_service_all" ON public.channel_discovery_runs USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
ALTER POLICY "channel_pool_service_write" ON public.channel_pool USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
ALTER POLICY "Auth users send" ON public.chat_messages WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "Auth users create comment likes" ON public.comment_likes WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "Users delete own comment likes" ON public.comment_likes USING ((auth.uid() = user_id));
ALTER POLICY "Auth users create" ON public.comments WITH CHECK ((auth.uid() = author_id));
ALTER POLICY "Authors delete own comments" ON public.comments USING ((auth.uid() = author_id));
ALTER POLICY "Authors update own comments" ON public.comments USING ((auth.uid() = author_id)) WITH CHECK ((auth.uid() = author_id));
ALTER POLICY "Operators delete any comments" ON public.comments USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.is_operator = true)))));
ALTER POLICY "Users delete own device token" ON public.device_push_tokens USING ((auth.uid() = user_id));
ALTER POLICY "Users insert own device token" ON public.device_push_tokens WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "Users read own device token" ON public.device_push_tokens USING ((auth.uid() = user_id));
ALTER POLICY "Users update own device token" ON public.device_push_tokens USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "dm_conv_insert" ON public.dm_conversations WITH CHECK (((user1_id IS NOT NULL) AND (user2_id IS NOT NULL) AND ((auth.uid() = user1_id) OR (auth.uid() = user2_id)) AND (NOT (EXISTS ( SELECT 1
   FROM user_blocks
  WHERE (((user_blocks.blocker_id = dm_conversations.user1_id) AND (user_blocks.blocked_id = dm_conversations.user2_id)) OR ((user_blocks.blocker_id = dm_conversations.user2_id) AND (user_blocks.blocked_id = dm_conversations.user1_id))))))));
ALTER POLICY "dm_conv_select" ON public.dm_conversations USING (((auth.uid() = user1_id) OR (auth.uid() = user2_id)));
ALTER POLICY "dm_conv_update" ON public.dm_conversations USING (((auth.uid() = user1_id) OR (auth.uid() = user2_id)));
ALTER POLICY "dm_msg_insert" ON public.dm_messages WITH CHECK (((auth.uid() = sender_id) AND (EXISTS ( SELECT 1
   FROM dm_conversations conversation
  WHERE ((conversation.id = dm_messages.conversation_id) AND (conversation.user1_id IS NOT NULL) AND (conversation.user2_id IS NOT NULL) AND ((conversation.user1_id = auth.uid()) OR (conversation.user2_id = auth.uid())) AND (NOT (EXISTS ( SELECT 1
           FROM user_blocks
          WHERE (((user_blocks.blocker_id = conversation.user1_id) AND (user_blocks.blocked_id = conversation.user2_id)) OR ((user_blocks.blocker_id = conversation.user2_id) AND (user_blocks.blocked_id = conversation.user1_id)))))))))));
ALTER POLICY "dm_msg_select" ON public.dm_messages USING ((EXISTS ( SELECT 1
   FROM dm_conversations c
  WHERE ((c.id = dm_messages.conversation_id) AND ((c.user1_id = auth.uid()) OR (c.user2_id = auth.uid()))))));
ALTER POLICY "dm_msg_update" ON public.dm_messages USING ((EXISTS ( SELECT 1
   FROM dm_conversations c
  WHERE ((c.id = dm_messages.conversation_id) AND ((c.user1_id = auth.uid()) OR (c.user2_id = auth.uid()))))));
ALTER POLICY "reports_insert" ON public.dm_reports WITH CHECK ((auth.uid() = reporter_id));
ALTER POLICY "reports_select" ON public.dm_reports USING ((auth.uid() = reporter_id));
ALTER POLICY "feedback_insert" ON public.feedback WITH CHECK ((auth.uid() IS NOT NULL));
ALTER POLICY "feedback_read" ON public.feedback USING (((user_id = auth.uid()) OR (status = ANY (ARRAY['resolved'::text, 'rejected'::text, 'duplicate'::text]))));
ALTER POLICY "feedback_vote_insert" ON public.feedback_votes WITH CHECK ((user_id = auth.uid()));
ALTER POLICY "gif_collector_queue_service_all" ON public.gif_collector_queue USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
ALTER POLICY "Create invites" ON public.invitations WITH CHECK ((auth.uid() = inviter_id));
ALTER POLICY "Read own invites" ON public.invitations USING (((auth.uid() = inviter_id) OR (auth.uid() = invitee_id)));
ALTER POLICY "Users read own refill" ON public.invite_refill_log USING ((auth.uid() = user_id));
ALTER POLICY "Auth users toggle" ON public.likes WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "Users delete own" ON public.likes USING ((auth.uid() = user_id));
ALTER POLICY "own la start token delete" ON public.live_activity_start_tokens USING ((auth.uid() = user_id));
ALTER POLICY "own la start token insert" ON public.live_activity_start_tokens WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "own la start token update" ON public.live_activity_start_tokens USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "own live activity tokens delete" ON public.live_activity_tokens USING ((auth.uid() = user_id));
ALTER POLICY "own live activity tokens insert" ON public.live_activity_tokens WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "own live activity tokens update" ON public.live_activity_tokens USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "Users insert own notification prefs" ON public.notification_prefs WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "Users read own notification prefs" ON public.notification_prefs USING ((auth.uid() = user_id));
ALTER POLICY "Users update own notification prefs" ON public.notification_prefs USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "Auth users create" ON public.posts WITH CHECK ((auth.uid() = author_id));
ALTER POLICY "Authors delete own posts" ON public.posts USING ((auth.uid() = author_id));
ALTER POLICY "Authors update own" ON public.posts USING ((auth.uid() = author_id));
ALTER POLICY "Operators delete any posts" ON public.posts USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.is_operator = true)))));
ALTER POLICY "Auth users vote" ON public.prediction_votes WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "Users read own nickname changes" ON public.profile_nickname_changes USING ((auth.uid() = user_id));
ALTER POLICY "Users create own" ON public.profiles WITH CHECK ((auth.uid() = id));
ALTER POLICY "Users update own" ON public.profiles USING ((auth.uid() = id));
ALTER POLICY "Users read own" ON public.push_subscriptions USING ((auth.uid() = user_id));
ALTER POLICY "Users create reports" ON public.reports WITH CHECK ((auth.uid() = reporter_id));
ALTER POLICY "Users read own reports" ON public.reports USING ((auth.uid() = reporter_id));
ALTER POLICY "Users create own" ON public.season_predictions WITH CHECK ((auth.uid() = user_id));
ALTER POLICY "Users update own" ON public.season_predictions USING ((auth.uid() = user_id));
ALTER POLICY "Service role full access on tester_signups" ON public.tester_signups USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
ALTER POLICY "Auth users create" ON public.ticket_transfers WITH CHECK ((auth.uid() = author_id));
ALTER POLICY "Authors delete own" ON public.ticket_transfers USING ((auth.uid() = author_id));
ALTER POLICY "Authors update own" ON public.ticket_transfers USING ((auth.uid() = author_id));
ALTER POLICY "blocks_delete" ON public.user_blocks USING ((auth.uid() = blocker_id));
ALTER POLICY "blocks_insert" ON public.user_blocks WITH CHECK ((auth.uid() = blocker_id));
ALTER POLICY "blocks_select" ON public.user_blocks USING (((auth.uid() = blocker_id) OR (auth.uid() = blocked_id)));
ALTER POLICY "videos_service_write" ON public.videos USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
ALTER POLICY "yql_service_all" ON public.youtube_quota_ledger USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));
