-- advisor 2단계-A rollback — initplan 67건을 baseline 원문 qual/with_check로 복원
-- 생성기: scripts/db/generate-advisor-step2-migration.py (수동 편집 금지 — --check로 결속)
-- 적용된 DB에서만 실행. migration chain 밖 파일 — supabase/migrations에 넣지 말 것.
--
-- 가드(fail-closed): 현재 상태가 정확히 post-migration 상태(fingerprint가 생성기
-- 예측 exact post_fp와 직접 일치)일 때만 복원. 미적용 baseline·일부 bare 원복·
-- missing·drift 전건 EXCEPTION. 단일 원자 블록. lock-before-read로 TOCTOU 차단.

SET lock_timeout = '5s';

DO $rb$
DECLARE r record; cur_fp text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('admin_page_views', $p0$apv_insert_own$p0$, '5f740e50844dbfd01c0a91bece84dfad', NULL, $c0$(user_id = auth.uid())$c0$),
    ('announcements', $p1$Service role full access on announcements$p1$, 'bec3227927e9b29c496067d91b3fc4f3', $u1$(auth.role() = 'service_role'::text)$u1$, $c1$(auth.role() = 'service_role'::text)$c1$),
    ('api_fallback_events', $p2$Admin read access$p2$, 'd56af95e9ccfd4ec8acf640c0a5b594e', $u2$(((auth.jwt() ->> 'role'::text) = 'admin'::text) OR ((auth.jwt() ->> 'role'::text) = 'service_role'::text))$u2$, NULL),
    ('api_fallback_events', $p3$Service role write access$p3$, 'bbfcc0b51bc57238e11a76c7a51f906a', NULL, $c3$((auth.jwt() ->> 'role'::text) = 'service_role'::text)$c3$),
    ('channel_discovery_candidates', $p4$cdc_service_all$p4$, 'bec3227927e9b29c496067d91b3fc4f3', $u4$(auth.role() = 'service_role'::text)$u4$, $c4$(auth.role() = 'service_role'::text)$c4$),
    ('channel_discovery_lock', $p5$cdl_service_all$p5$, 'bec3227927e9b29c496067d91b3fc4f3', $u5$(auth.role() = 'service_role'::text)$u5$, $c5$(auth.role() = 'service_role'::text)$c5$),
    ('channel_discovery_runs', $p6$cdr_service_all$p6$, 'bec3227927e9b29c496067d91b3fc4f3', $u6$(auth.role() = 'service_role'::text)$u6$, $c6$(auth.role() = 'service_role'::text)$c6$),
    ('channel_pool', $p7$channel_pool_service_write$p7$, 'bec3227927e9b29c496067d91b3fc4f3', $u7$(auth.role() = 'service_role'::text)$u7$, $c7$(auth.role() = 'service_role'::text)$c7$),
    ('chat_messages', $p8$Auth users send$p8$, 'efa0dc68184a69f47bba35c850000cee', NULL, $c8$(auth.uid() = user_id)$c8$),
    ('comment_likes', $p9$Auth users create comment likes$p9$, 'efa0dc68184a69f47bba35c850000cee', NULL, $c9$(auth.uid() = user_id)$c9$),
    ('comment_likes', $p10$Users delete own comment likes$p10$, '939e1f945082d26c81de397d466591e1', $u10$(auth.uid() = user_id)$u10$, NULL),
    ('comments', $p11$Auth users create$p11$, '5ba9de8808825d7d2f2628990074c013', NULL, $c11$(auth.uid() = author_id)$c11$),
    ('comments', $p12$Authors delete own comments$p12$, 'e062117519b3bede4b6d61ab1e30785b', $u12$(auth.uid() = author_id)$u12$, NULL),
    ('comments', $p13$Authors update own comments$p13$, '8620a4c69810095dc6dbfc3cc383ba4a', $u13$(auth.uid() = author_id)$u13$, $c13$(auth.uid() = author_id)$c13$),
    ('comments', $p14$Operators delete any comments$p14$, '511fd4f21f88d53d86a3f149eef96b8c', $u14$(EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.is_operator = true))))$u14$, NULL),
    ('device_push_tokens', $p15$Users delete own device token$p15$, '939e1f945082d26c81de397d466591e1', $u15$(auth.uid() = user_id)$u15$, NULL),
    ('device_push_tokens', $p16$Users insert own device token$p16$, 'efa0dc68184a69f47bba35c850000cee', NULL, $c16$(auth.uid() = user_id)$c16$),
    ('device_push_tokens', $p17$Users read own device token$p17$, 'ce1d5cb01414a517b39bbf99e8fcdc52', $u17$(auth.uid() = user_id)$u17$, NULL),
    ('device_push_tokens', $p18$Users update own device token$p18$, 'bbcc6371ca76470c1338beb2c5e55b47', $u18$(auth.uid() = user_id)$u18$, $c18$(auth.uid() = user_id)$c18$),
    ('dm_conversations', $p19$dm_conv_insert$p19$, '0e7c2b6107a884ab8bc5d1281dec0b8a', NULL, $c19$((user1_id IS NOT NULL) AND (user2_id IS NOT NULL) AND ((auth.uid() = user1_id) OR (auth.uid() = user2_id)) AND (NOT (EXISTS ( SELECT 1
   FROM user_blocks
  WHERE (((user_blocks.blocker_id = dm_conversations.user1_id) AND (user_blocks.blocked_id = dm_conversations.user2_id)) OR ((user_blocks.blocker_id = dm_conversations.user2_id) AND (user_blocks.blocked_id = dm_conversations.user1_id)))))))$c19$),
    ('dm_conversations', $p20$dm_conv_select$p20$, 'c00b335f62e43420a5208575280b5a6d', $u20$((auth.uid() = user1_id) OR (auth.uid() = user2_id))$u20$, NULL),
    ('dm_conversations', $p21$dm_conv_update$p21$, '617ef0283b83ae93571bcb3178731a55', $u21$((auth.uid() = user1_id) OR (auth.uid() = user2_id))$u21$, NULL),
    ('dm_messages', $p22$dm_msg_insert$p22$, 'fe76adbb750485b9cd038f88176c2899', NULL, $c22$((auth.uid() = sender_id) AND (EXISTS ( SELECT 1
   FROM dm_conversations conversation
  WHERE ((conversation.id = dm_messages.conversation_id) AND (conversation.user1_id IS NOT NULL) AND (conversation.user2_id IS NOT NULL) AND ((conversation.user1_id = auth.uid()) OR (conversation.user2_id = auth.uid())) AND (NOT (EXISTS ( SELECT 1
           FROM user_blocks
          WHERE (((user_blocks.blocker_id = conversation.user1_id) AND (user_blocks.blocked_id = conversation.user2_id)) OR ((user_blocks.blocker_id = conversation.user2_id) AND (user_blocks.blocked_id = conversation.user1_id))))))))))$c22$),
    ('dm_messages', $p23$dm_msg_select$p23$, '020d4effdb0be52e6b5f5a2254fd4902', $u23$(EXISTS ( SELECT 1
   FROM dm_conversations c
  WHERE ((c.id = dm_messages.conversation_id) AND ((c.user1_id = auth.uid()) OR (c.user2_id = auth.uid())))))$u23$, NULL),
    ('dm_messages', $p24$dm_msg_update$p24$, 'b76388a39088bde0a7a45a8d8ed7438e', $u24$(EXISTS ( SELECT 1
   FROM dm_conversations c
  WHERE ((c.id = dm_messages.conversation_id) AND ((c.user1_id = auth.uid()) OR (c.user2_id = auth.uid())))))$u24$, NULL),
    ('dm_reports', $p25$reports_insert$p25$, '847b5177b737ca2ffdeb60c599a68b44', NULL, $c25$(auth.uid() = reporter_id)$c25$),
    ('dm_reports', $p26$reports_select$p26$, 'd126c845417ff88c612caa7a191eba26', $u26$(auth.uid() = reporter_id)$u26$, NULL),
    ('feedback', $p27$feedback_insert$p27$, '63b74c20577629c71758042008860dd0', NULL, $c27$(auth.uid() IS NOT NULL)$c27$),
    ('feedback', $p28$feedback_read$p28$, 'e68f19b739c8ec2f67073610c815292c', $u28$((user_id = auth.uid()) OR (status = ANY (ARRAY['resolved'::text, 'rejected'::text, 'duplicate'::text])))$u28$, NULL),
    ('feedback_votes', $p29$feedback_vote_insert$p29$, 'fcfaa6c8de332886be327ee949aa90b8', NULL, $c29$(user_id = auth.uid())$c29$),
    ('gif_collector_queue', $p30$gif_collector_queue_service_all$p30$, 'bec3227927e9b29c496067d91b3fc4f3', $u30$(auth.role() = 'service_role'::text)$u30$, $c30$(auth.role() = 'service_role'::text)$c30$),
    ('invitations', $p31$Create invites$p31$, '5751ffbbb421dbec1b18ebccd1aae328', NULL, $c31$(auth.uid() = inviter_id)$c31$),
    ('invitations', $p32$Read own invites$p32$, 'b874761a4b6fc4d0ae2142e7107bbd24', $u32$((auth.uid() = inviter_id) OR (auth.uid() = invitee_id))$u32$, NULL),
    ('invite_refill_log', $p33$Users read own refill$p33$, 'ce1d5cb01414a517b39bbf99e8fcdc52', $u33$(auth.uid() = user_id)$u33$, NULL),
    ('likes', $p34$Auth users toggle$p34$, 'efa0dc68184a69f47bba35c850000cee', NULL, $c34$(auth.uid() = user_id)$c34$),
    ('likes', $p35$Users delete own$p35$, '939e1f945082d26c81de397d466591e1', $u35$(auth.uid() = user_id)$u35$, NULL),
    ('live_activity_start_tokens', $p36$own la start token delete$p36$, '9d65b0219ce4fbcb5cc73bc5611bdce4', $u36$(auth.uid() = user_id)$u36$, NULL),
    ('live_activity_start_tokens', $p37$own la start token insert$p37$, '7fea51adf4035158aaf032b93740fe19', NULL, $c37$(auth.uid() = user_id)$c37$),
    ('live_activity_start_tokens', $p38$own la start token update$p38$, '1fc62e9054b64a8b4ae5aedc2321a329', $u38$(auth.uid() = user_id)$u38$, $c38$(auth.uid() = user_id)$c38$),
    ('live_activity_tokens', $p39$own live activity tokens delete$p39$, '9d65b0219ce4fbcb5cc73bc5611bdce4', $u39$(auth.uid() = user_id)$u39$, NULL),
    ('live_activity_tokens', $p40$own live activity tokens insert$p40$, '7fea51adf4035158aaf032b93740fe19', NULL, $c40$(auth.uid() = user_id)$c40$),
    ('live_activity_tokens', $p41$own live activity tokens update$p41$, '1fc62e9054b64a8b4ae5aedc2321a329', $u41$(auth.uid() = user_id)$u41$, $c41$(auth.uid() = user_id)$c41$),
    ('notification_prefs', $p42$Users insert own notification prefs$p42$, 'efa0dc68184a69f47bba35c850000cee', NULL, $c42$(auth.uid() = user_id)$c42$),
    ('notification_prefs', $p43$Users read own notification prefs$p43$, 'ce1d5cb01414a517b39bbf99e8fcdc52', $u43$(auth.uid() = user_id)$u43$, NULL),
    ('notification_prefs', $p44$Users update own notification prefs$p44$, 'bbcc6371ca76470c1338beb2c5e55b47', $u44$(auth.uid() = user_id)$u44$, $c44$(auth.uid() = user_id)$c44$),
    ('posts', $p45$Auth users create$p45$, '5ba9de8808825d7d2f2628990074c013', NULL, $c45$(auth.uid() = author_id)$c45$),
    ('posts', $p46$Authors delete own posts$p46$, 'e062117519b3bede4b6d61ab1e30785b', $u46$(auth.uid() = author_id)$u46$, NULL),
    ('posts', $p47$Authors update own$p47$, 'ebeb7778f85e2866c0e9cfce21ad7ef3', $u47$(auth.uid() = author_id)$u47$, NULL),
    ('posts', $p48$Operators delete any posts$p48$, '511fd4f21f88d53d86a3f149eef96b8c', $u48$(EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.is_operator = true))))$u48$, NULL),
    ('prediction_votes', $p49$Auth users vote$p49$, 'efa0dc68184a69f47bba35c850000cee', NULL, $c49$(auth.uid() = user_id)$c49$),
    ('profile_nickname_changes', $p50$Users read own nickname changes$p50$, 'ce1d5cb01414a517b39bbf99e8fcdc52', $u50$(auth.uid() = user_id)$u50$, NULL),
    ('profiles', $p51$Users create own$p51$, '0da5c100877b187b805d158ab3bd3643', NULL, $c51$(auth.uid() = id)$c51$),
    ('profiles', $p52$Users update own$p52$, '32f2ac8424830bffe2a351ac274baf29', $u52$(auth.uid() = id)$u52$, NULL),
    ('push_subscriptions', $p53$Users read own$p53$, 'ce1d5cb01414a517b39bbf99e8fcdc52', $u53$(auth.uid() = user_id)$u53$, NULL),
    ('reports', $p54$Users create reports$p54$, '847b5177b737ca2ffdeb60c599a68b44', NULL, $c54$(auth.uid() = reporter_id)$c54$),
    ('reports', $p55$Users read own reports$p55$, 'd126c845417ff88c612caa7a191eba26', $u55$(auth.uid() = reporter_id)$u55$, NULL),
    ('season_predictions', $p56$Users create own$p56$, 'efa0dc68184a69f47bba35c850000cee', NULL, $c56$(auth.uid() = user_id)$c56$),
    ('season_predictions', $p57$Users update own$p57$, 'd2652b1e953537c41ab59675f0b19a1f', $u57$(auth.uid() = user_id)$u57$, NULL),
    ('tester_signups', $p58$Service role full access on tester_signups$p58$, 'bec3227927e9b29c496067d91b3fc4f3', $u58$(auth.role() = 'service_role'::text)$u58$, $c58$(auth.role() = 'service_role'::text)$c58$),
    ('ticket_transfers', $p59$Auth users create$p59$, '5ba9de8808825d7d2f2628990074c013', NULL, $c59$(auth.uid() = author_id)$c59$),
    ('ticket_transfers', $p60$Authors delete own$p60$, 'e062117519b3bede4b6d61ab1e30785b', $u60$(auth.uid() = author_id)$u60$, NULL),
    ('ticket_transfers', $p61$Authors update own$p61$, 'ebeb7778f85e2866c0e9cfce21ad7ef3', $u61$(auth.uid() = author_id)$u61$, NULL),
    ('user_blocks', $p62$blocks_delete$p62$, '0f1a8ee5d1e21d3df62e192544a97555', $u62$(auth.uid() = blocker_id)$u62$, NULL),
    ('user_blocks', $p63$blocks_insert$p63$, 'c904e6b8bb379b214dc4100d8673d478', NULL, $c63$(auth.uid() = blocker_id)$c63$),
    ('user_blocks', $p64$blocks_select$p64$, '74a3a22b4ae12e2d12b2b7ef0b56ef8a', $u64$((auth.uid() = blocker_id) OR (auth.uid() = blocked_id))$u64$, NULL),
    ('videos', $p65$videos_service_write$p65$, 'bec3227927e9b29c496067d91b3fc4f3', $u65$(auth.role() = 'service_role'::text)$u65$, $c65$(auth.role() = 'service_role'::text)$c65$),
    ('youtube_quota_ledger', $p66$yql_service_all$p66$, 'bec3227927e9b29c496067d91b3fc4f3', $u66$(auth.role() = 'service_role'::text)$u66$, $c66$(auth.role() = 'service_role'::text)$c66$)
  ) AS t(tbl, pol, post_fp, old_using, old_check)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      RAISE EXCEPTION 'advisor_step2a_rollback: table % missing — rollback은 적용된 DB 전제', r.tbl;
    END IF;
    -- lock-before-read: fingerprint SELECT와 ALTER 사이 동시 정책 DDL TOCTOU 차단
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', r.tbl);
    SELECT md5(coalesce(cmd,'') || '|' || coalesce(permissive,'') || '|' ||
               coalesce(roles::text,'') || '|' || coalesce(qual,'') || '|' || coalesce(with_check,''))
      INTO cur_fp FROM pg_policies
     WHERE schemaname='public' AND tablename=r.tbl AND policyname=r.pol;
    IF cur_fp IS NULL THEN
      RAISE EXCEPTION 'advisor_step2a_rollback: policy %.% missing — refusing', r.tbl, r.pol;
    END IF;
    IF cur_fp <> r.post_fp THEN
      RAISE EXCEPTION 'advisor_step2a_rollback: %.% is not in exact post-migration state — refusing (drift)', r.tbl, r.pol;
    END IF;
    EXECUTE format('ALTER POLICY %I ON public.%I %s %s', r.pol, r.tbl,
      CASE WHEN r.old_using IS NOT NULL THEN 'USING (' || r.old_using || ')' ELSE '' END,
      CASE WHEN r.old_check IS NOT NULL THEN 'WITH CHECK (' || r.old_check || ')' ELSE '' END);
  END LOOP;
END $rb$;
