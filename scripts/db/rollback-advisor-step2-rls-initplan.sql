-- advisor 2단계-A rollback — initplan 67건을 baseline 원문 qual/with_check로 복원
-- 생성기: scripts/db/generate-advisor-step2-migration.py (수동 편집 금지 — --check로 결속)
-- 적용된 DB에서만 실행. migration chain 밖 파일 — supabase/migrations에 넣지 말 것.
--
-- 가드(fail-closed): 현재 상태가 정확히 post-migration 상태(unwrap 시 baseline과
-- full fingerprint 일치)일 때만 복원. missing·drift 전건 EXCEPTION. 단일 원자 블록.

SET lock_timeout = '5s';

DO $rb$
DECLARE r record; cur_unwrapped_fp text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('admin_page_views', $p0$apv_insert_own$p0$, '4eaed517d98408432a5068a6fef4c609', NULL, $c0$(user_id = auth.uid())$c0$),
    ('announcements', $p1$Service role full access on announcements$p1$, '5364e1efc87497c6dbe48cf88208678c', $u1$(auth.role() = 'service_role'::text)$u1$, $c1$(auth.role() = 'service_role'::text)$c1$),
    ('api_fallback_events', $p2$Admin read access$p2$, 'a2ee04203e203a3c510cc3820817b824', $u2$(((auth.jwt() ->> 'role'::text) = 'admin'::text) OR ((auth.jwt() ->> 'role'::text) = 'service_role'::text))$u2$, NULL),
    ('api_fallback_events', $p3$Service role write access$p3$, 'ab68516ad5a8ce8f0d459c424dec600d', NULL, $c3$((auth.jwt() ->> 'role'::text) = 'service_role'::text)$c3$),
    ('channel_discovery_candidates', $p4$cdc_service_all$p4$, '5364e1efc87497c6dbe48cf88208678c', $u4$(auth.role() = 'service_role'::text)$u4$, $c4$(auth.role() = 'service_role'::text)$c4$),
    ('channel_discovery_lock', $p5$cdl_service_all$p5$, '5364e1efc87497c6dbe48cf88208678c', $u5$(auth.role() = 'service_role'::text)$u5$, $c5$(auth.role() = 'service_role'::text)$c5$),
    ('channel_discovery_runs', $p6$cdr_service_all$p6$, '5364e1efc87497c6dbe48cf88208678c', $u6$(auth.role() = 'service_role'::text)$u6$, $c6$(auth.role() = 'service_role'::text)$c6$),
    ('channel_pool', $p7$channel_pool_service_write$p7$, '5364e1efc87497c6dbe48cf88208678c', $u7$(auth.role() = 'service_role'::text)$u7$, $c7$(auth.role() = 'service_role'::text)$c7$),
    ('chat_messages', $p8$Auth users send$p8$, 'f2739cd14119c0746a9b4ccdef512edb', NULL, $c8$(auth.uid() = user_id)$c8$),
    ('comment_likes', $p9$Auth users create comment likes$p9$, 'f2739cd14119c0746a9b4ccdef512edb', NULL, $c9$(auth.uid() = user_id)$c9$),
    ('comment_likes', $p10$Users delete own comment likes$p10$, '6ed716154e1e09773fa2bd74e7208a86', $u10$(auth.uid() = user_id)$u10$, NULL),
    ('comments', $p11$Auth users create$p11$, '83dcf09c8a4582cb2be651157bf4cf5c', NULL, $c11$(auth.uid() = author_id)$c11$),
    ('comments', $p12$Authors delete own comments$p12$, '4b0b2c090af4088a7dcb1dcc325d6b75', $u12$(auth.uid() = author_id)$u12$, NULL),
    ('comments', $p13$Authors update own comments$p13$, '1d5bb54cef04cf752f3cfd4e768e3e1f', $u13$(auth.uid() = author_id)$u13$, $c13$(auth.uid() = author_id)$c13$),
    ('comments', $p14$Operators delete any comments$p14$, '24ccc56b5923652ebf366140f79eaf03', $u14$(EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.is_operator = true))))$u14$, NULL),
    ('device_push_tokens', $p15$Users delete own device token$p15$, '6ed716154e1e09773fa2bd74e7208a86', $u15$(auth.uid() = user_id)$u15$, NULL),
    ('device_push_tokens', $p16$Users insert own device token$p16$, 'f2739cd14119c0746a9b4ccdef512edb', NULL, $c16$(auth.uid() = user_id)$c16$),
    ('device_push_tokens', $p17$Users read own device token$p17$, '5a6d1d80acd727fee282c1de2a1ee7ed', $u17$(auth.uid() = user_id)$u17$, NULL),
    ('device_push_tokens', $p18$Users update own device token$p18$, 'e89e6c906920bb420f420d4384385bce', $u18$(auth.uid() = user_id)$u18$, $c18$(auth.uid() = user_id)$c18$),
    ('dm_conversations', $p19$dm_conv_insert$p19$, 'db215414c8020089a9297e266cf7cf28', NULL, $c19$((user1_id IS NOT NULL) AND (user2_id IS NOT NULL) AND ((auth.uid() = user1_id) OR (auth.uid() = user2_id)) AND (NOT (EXISTS ( SELECT 1
   FROM user_blocks
  WHERE (((user_blocks.blocker_id = dm_conversations.user1_id) AND (user_blocks.blocked_id = dm_conversations.user2_id)) OR ((user_blocks.blocker_id = dm_conversations.user2_id) AND (user_blocks.blocked_id = dm_conversations.user1_id)))))))$c19$),
    ('dm_conversations', $p20$dm_conv_select$p20$, 'cbb313189ff26920ae9eca15f20aac68', $u20$((auth.uid() = user1_id) OR (auth.uid() = user2_id))$u20$, NULL),
    ('dm_conversations', $p21$dm_conv_update$p21$, '27279652cd3be077667922319f91c6e9', $u21$((auth.uid() = user1_id) OR (auth.uid() = user2_id))$u21$, NULL),
    ('dm_messages', $p22$dm_msg_insert$p22$, '5d16269a37f9a04043e25b2fd1f1858f', NULL, $c22$((auth.uid() = sender_id) AND (EXISTS ( SELECT 1
   FROM dm_conversations conversation
  WHERE ((conversation.id = dm_messages.conversation_id) AND (conversation.user1_id IS NOT NULL) AND (conversation.user2_id IS NOT NULL) AND ((conversation.user1_id = auth.uid()) OR (conversation.user2_id = auth.uid())) AND (NOT (EXISTS ( SELECT 1
           FROM user_blocks
          WHERE (((user_blocks.blocker_id = conversation.user1_id) AND (user_blocks.blocked_id = conversation.user2_id)) OR ((user_blocks.blocker_id = conversation.user2_id) AND (user_blocks.blocked_id = conversation.user1_id))))))))))$c22$),
    ('dm_messages', $p23$dm_msg_select$p23$, '567b852faedbb6105c6c6b278d6c3bd6', $u23$(EXISTS ( SELECT 1
   FROM dm_conversations c
  WHERE ((c.id = dm_messages.conversation_id) AND ((c.user1_id = auth.uid()) OR (c.user2_id = auth.uid())))))$u23$, NULL),
    ('dm_messages', $p24$dm_msg_update$p24$, '4686578d1a99cf750b0734e5f495634c', $u24$(EXISTS ( SELECT 1
   FROM dm_conversations c
  WHERE ((c.id = dm_messages.conversation_id) AND ((c.user1_id = auth.uid()) OR (c.user2_id = auth.uid())))))$u24$, NULL),
    ('dm_reports', $p25$reports_insert$p25$, '69675a06f4e4a8d92fc2b35b24db2e4f', NULL, $c25$(auth.uid() = reporter_id)$c25$),
    ('dm_reports', $p26$reports_select$p26$, '09ae4365c856efae63a7a461155782c7', $u26$(auth.uid() = reporter_id)$u26$, NULL),
    ('feedback', $p27$feedback_insert$p27$, '96ad2b73395f3581642de752746d3bdd', NULL, $c27$(auth.uid() IS NOT NULL)$c27$),
    ('feedback', $p28$feedback_read$p28$, '8c75d8e3f9a424f64e412f04198bb491', $u28$((user_id = auth.uid()) OR (status = ANY (ARRAY['resolved'::text, 'rejected'::text, 'duplicate'::text])))$u28$, NULL),
    ('feedback_votes', $p29$feedback_vote_insert$p29$, 'daeb90990746d5012be991893fa5e5bd', NULL, $c29$(user_id = auth.uid())$c29$),
    ('gif_collector_queue', $p30$gif_collector_queue_service_all$p30$, '5364e1efc87497c6dbe48cf88208678c', $u30$(auth.role() = 'service_role'::text)$u30$, $c30$(auth.role() = 'service_role'::text)$c30$),
    ('invitations', $p31$Create invites$p31$, 'a153d1f86f07d26a0af8be7c5d44687f', NULL, $c31$(auth.uid() = inviter_id)$c31$),
    ('invitations', $p32$Read own invites$p32$, '1cf7ad7c657b38b1c1e08db94bc4e191', $u32$((auth.uid() = inviter_id) OR (auth.uid() = invitee_id))$u32$, NULL),
    ('invite_refill_log', $p33$Users read own refill$p33$, '5a6d1d80acd727fee282c1de2a1ee7ed', $u33$(auth.uid() = user_id)$u33$, NULL),
    ('likes', $p34$Auth users toggle$p34$, 'f2739cd14119c0746a9b4ccdef512edb', NULL, $c34$(auth.uid() = user_id)$c34$),
    ('likes', $p35$Users delete own$p35$, '6ed716154e1e09773fa2bd74e7208a86', $u35$(auth.uid() = user_id)$u35$, NULL),
    ('live_activity_start_tokens', $p36$own la start token delete$p36$, '5ca9cd5c7e2efc0e23fed52bdc00e1e4', $u36$(auth.uid() = user_id)$u36$, NULL),
    ('live_activity_start_tokens', $p37$own la start token insert$p37$, '96f03ec053526c0252b11a0808e46c09', NULL, $c37$(auth.uid() = user_id)$c37$),
    ('live_activity_start_tokens', $p38$own la start token update$p38$, '993a1c62ab40a230c2ed78299a4b53c0', $u38$(auth.uid() = user_id)$u38$, $c38$(auth.uid() = user_id)$c38$),
    ('live_activity_tokens', $p39$own live activity tokens delete$p39$, '5ca9cd5c7e2efc0e23fed52bdc00e1e4', $u39$(auth.uid() = user_id)$u39$, NULL),
    ('live_activity_tokens', $p40$own live activity tokens insert$p40$, '96f03ec053526c0252b11a0808e46c09', NULL, $c40$(auth.uid() = user_id)$c40$),
    ('live_activity_tokens', $p41$own live activity tokens update$p41$, '993a1c62ab40a230c2ed78299a4b53c0', $u41$(auth.uid() = user_id)$u41$, $c41$(auth.uid() = user_id)$c41$),
    ('notification_prefs', $p42$Users insert own notification prefs$p42$, 'f2739cd14119c0746a9b4ccdef512edb', NULL, $c42$(auth.uid() = user_id)$c42$),
    ('notification_prefs', $p43$Users read own notification prefs$p43$, '5a6d1d80acd727fee282c1de2a1ee7ed', $u43$(auth.uid() = user_id)$u43$, NULL),
    ('notification_prefs', $p44$Users update own notification prefs$p44$, 'e89e6c906920bb420f420d4384385bce', $u44$(auth.uid() = user_id)$u44$, $c44$(auth.uid() = user_id)$c44$),
    ('posts', $p45$Auth users create$p45$, '83dcf09c8a4582cb2be651157bf4cf5c', NULL, $c45$(auth.uid() = author_id)$c45$),
    ('posts', $p46$Authors delete own posts$p46$, '4b0b2c090af4088a7dcb1dcc325d6b75', $u46$(auth.uid() = author_id)$u46$, NULL),
    ('posts', $p47$Authors update own$p47$, '750684f02241760a82421e7f69bd3aff', $u47$(auth.uid() = author_id)$u47$, NULL),
    ('posts', $p48$Operators delete any posts$p48$, '24ccc56b5923652ebf366140f79eaf03', $u48$(EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.is_operator = true))))$u48$, NULL),
    ('prediction_votes', $p49$Auth users vote$p49$, 'f2739cd14119c0746a9b4ccdef512edb', NULL, $c49$(auth.uid() = user_id)$c49$),
    ('profile_nickname_changes', $p50$Users read own nickname changes$p50$, '5a6d1d80acd727fee282c1de2a1ee7ed', $u50$(auth.uid() = user_id)$u50$, NULL),
    ('profiles', $p51$Users create own$p51$, 'f346a946d48465c9d7ab76f684d3d505', NULL, $c51$(auth.uid() = id)$c51$),
    ('profiles', $p52$Users update own$p52$, 'f1cd57bcead88360bb952491b2e5aa18', $u52$(auth.uid() = id)$u52$, NULL),
    ('push_subscriptions', $p53$Users read own$p53$, '5a6d1d80acd727fee282c1de2a1ee7ed', $u53$(auth.uid() = user_id)$u53$, NULL),
    ('reports', $p54$Users create reports$p54$, '69675a06f4e4a8d92fc2b35b24db2e4f', NULL, $c54$(auth.uid() = reporter_id)$c54$),
    ('reports', $p55$Users read own reports$p55$, '09ae4365c856efae63a7a461155782c7', $u55$(auth.uid() = reporter_id)$u55$, NULL),
    ('season_predictions', $p56$Users create own$p56$, 'f2739cd14119c0746a9b4ccdef512edb', NULL, $c56$(auth.uid() = user_id)$c56$),
    ('season_predictions', $p57$Users update own$p57$, 'ac58310b277b7e3dcccd7ea2d811518a', $u57$(auth.uid() = user_id)$u57$, NULL),
    ('tester_signups', $p58$Service role full access on tester_signups$p58$, '5364e1efc87497c6dbe48cf88208678c', $u58$(auth.role() = 'service_role'::text)$u58$, $c58$(auth.role() = 'service_role'::text)$c58$),
    ('ticket_transfers', $p59$Auth users create$p59$, '83dcf09c8a4582cb2be651157bf4cf5c', NULL, $c59$(auth.uid() = author_id)$c59$),
    ('ticket_transfers', $p60$Authors delete own$p60$, '4b0b2c090af4088a7dcb1dcc325d6b75', $u60$(auth.uid() = author_id)$u60$, NULL),
    ('ticket_transfers', $p61$Authors update own$p61$, '750684f02241760a82421e7f69bd3aff', $u61$(auth.uid() = author_id)$u61$, NULL),
    ('user_blocks', $p62$blocks_delete$p62$, 'b25046fe6bf7c8155ae15c27f107309b', $u62$(auth.uid() = blocker_id)$u62$, NULL),
    ('user_blocks', $p63$blocks_insert$p63$, '280b40ed8902b555ccc9dc23df4e457f', NULL, $c63$(auth.uid() = blocker_id)$c63$),
    ('user_blocks', $p64$blocks_select$p64$, 'af8864ff993b7a36b51bd99d58935735', $u64$((auth.uid() = blocker_id) OR (auth.uid() = blocked_id))$u64$, NULL),
    ('videos', $p65$videos_service_write$p65$, '5364e1efc87497c6dbe48cf88208678c', $u65$(auth.role() = 'service_role'::text)$u65$, $c65$(auth.role() = 'service_role'::text)$c65$),
    ('youtube_quota_ledger', $p66$yql_service_all$p66$, '5364e1efc87497c6dbe48cf88208678c', $u66$(auth.role() = 'service_role'::text)$u66$, $c66$(auth.role() = 'service_role'::text)$c66$)
  ) AS t(tbl, pol, baseline_fp, old_using, old_check)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      RAISE EXCEPTION 'advisor_step2a_rollback: table % missing — rollback은 적용된 DB 전제', r.tbl;
    END IF;
    SELECT md5(coalesce(cmd,'') || '|' || coalesce(permissive,'') || '|' || coalesce(roles::text,'') || '|' ||
           regexp_replace(coalesce(qual,''),
             '\( SELECT auth\.(uid|role|jwt|email)\(\) AS [a-z]+\)', 'auth.\1()', 'g') || '|' ||
           regexp_replace(coalesce(with_check,''),
             '\( SELECT auth\.(uid|role|jwt|email)\(\) AS [a-z]+\)', 'auth.\1()', 'g'))
      INTO cur_unwrapped_fp FROM pg_policies
     WHERE schemaname='public' AND tablename=r.tbl AND policyname=r.pol;
    IF cur_unwrapped_fp IS NULL THEN
      RAISE EXCEPTION 'advisor_step2a_rollback: policy %.% missing — refusing', r.tbl, r.pol;
    END IF;
    IF cur_unwrapped_fp <> r.baseline_fp THEN
      RAISE EXCEPTION 'advisor_step2a_rollback: %.% is not in post-migration state — refusing (drift)', r.tbl, r.pol;
    END IF;
    EXECUTE format('ALTER POLICY %I ON public.%I %s %s', r.pol, r.tbl,
      CASE WHEN r.old_using IS NOT NULL THEN 'USING (' || r.old_using || ')' ELSE '' END,
      CASE WHEN r.old_check IS NOT NULL THEN 'WITH CHECK (' || r.old_check || ')' ELSE '' END);
  END LOOP;
END $rb$;
