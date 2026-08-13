-- Supabase advisor 2단계 — RLS initplan 67건 + 중복 permissive 정책 26건
-- 2026-08-13 하린아빠 착수 승인 (#infra 1786505729.677579)
-- 생성기: scripts/db/generate-advisor-step2-migration.py (수동 편집 금지)
-- baseline: scripts/qa/fixtures/rls-policies-baseline-20260813.json (production 기계 추출)
--
-- 가드: baseline md5 일치 → 실행 / bare auth 없음 → skip(멱등) / 그 외 drift → EXCEPTION
--       테이블·정책 부재 → skip (clean chain 안전)
-- rollback: 이 파일 하단 주석의 역방향 SQL 전문 참조

SET lock_timeout = '5s';

-- 공용 가드 함수 (마이그레이션 안에서만 사용, 종료 시 DROP)
CREATE OR REPLACE FUNCTION pg_temp._adv2_policy_md5(p_tbl text, p_pol text)
RETURNS text LANGUAGE sql AS $fn$
  SELECT md5(coalesce(qual,'') || '|' || coalesce(with_check,''))
  FROM pg_policies WHERE schemaname='public' AND tablename=p_tbl AND policyname=p_pol
$fn$;
-- bare auth 호출 검출: 래핑된 'SELECT auth.<fn>()' 발생부를 제거한 뒤 잔여 호출을 본다
-- (PG POSIX 정규식은 lookbehind 미지원)
CREATE OR REPLACE FUNCTION pg_temp._adv2_has_bare_auth(p_tbl text, p_pol text)
RETURNS boolean LANGUAGE sql AS $fn$
  SELECT regexp_replace(
           coalesce(qual,'') || ' ' || coalesce(with_check,''),
           '[Ss][Ee][Ll][Ee][Cc][Tt] auth\.(uid|role|jwt|email)\(\)', '', 'g')
         ~ 'auth\.(uid|role|jwt|email)\(\)'
  FROM pg_policies WHERE schemaname='public' AND tablename=p_tbl AND policyname=p_pol
$fn$;

-- ---- Part B: 정책 재구성 (중복 permissive 해소) --------------------------
DO $mig$
DECLARE cur_md5 text;
BEGIN
  -- (drop 대상) md5 일치 → DROP / 이미 service_role 스코핑(멱등 재실행) → skip / 그 외 drift → 거부
  IF to_regclass('public.announcements') IS NOT NULL THEN
    cur_md5 := pg_temp._adv2_policy_md5('announcements', $p$Service role full access on announcements$p$);
    IF cur_md5 IS NOT NULL THEN
      IF cur_md5 = '445e2c3db9ca7ceee07b914252592306' THEN
        EXECUTE format('DROP POLICY %I ON public.%I', $p$Service role full access on announcements$p$, 'announcements');
      ELSIF (SELECT roles::text FROM pg_policies WHERE schemaname='public'
             AND tablename='announcements' AND policyname=$p$Service role full access on announcements$p$) = '{service_role}' THEN
        NULL; -- 이미 스코핑된 재실행 — skip
      ELSE
        RAISE EXCEPTION 'advisor_step2: policy drift on %.% — refusing', 'announcements', $p$Service role full access on announcements$p$;
      END IF;
    END IF;
  END IF;
  IF to_regclass('public.channel_pool') IS NOT NULL THEN
    cur_md5 := pg_temp._adv2_policy_md5('channel_pool', $p$channel_pool_service_write$p$);
    IF cur_md5 IS NOT NULL THEN
      IF cur_md5 = '445e2c3db9ca7ceee07b914252592306' THEN
        EXECUTE format('DROP POLICY %I ON public.%I', $p$channel_pool_service_write$p$, 'channel_pool');
      ELSIF (SELECT roles::text FROM pg_policies WHERE schemaname='public'
             AND tablename='channel_pool' AND policyname=$p$channel_pool_service_write$p$) = '{service_role}' THEN
        NULL; -- 이미 스코핑된 재실행 — skip
      ELSE
        RAISE EXCEPTION 'advisor_step2: policy drift on %.% — refusing', 'channel_pool', $p$channel_pool_service_write$p$;
      END IF;
    END IF;
  END IF;
  IF to_regclass('public.videos') IS NOT NULL THEN
    cur_md5 := pg_temp._adv2_policy_md5('videos', $p$videos_service_write$p$);
    IF cur_md5 IS NOT NULL THEN
      IF cur_md5 = '445e2c3db9ca7ceee07b914252592306' THEN
        EXECUTE format('DROP POLICY %I ON public.%I', $p$videos_service_write$p$, 'videos');
      ELSIF (SELECT roles::text FROM pg_policies WHERE schemaname='public'
             AND tablename='videos' AND policyname=$p$videos_service_write$p$) = '{service_role}' THEN
        NULL; -- 이미 스코핑된 재실행 — skip
      ELSE
        RAISE EXCEPTION 'advisor_step2: policy drift on %.% — refusing', 'videos', $p$videos_service_write$p$;
      END IF;
    END IF;
  END IF;
  IF to_regclass('public.highlights') IS NOT NULL THEN
    cur_md5 := pg_temp._adv2_policy_md5('highlights', $p$highlights_write$p$);
    IF cur_md5 IS NOT NULL THEN
      IF cur_md5 = 'eb28d87532d6edd9b635727493ef89f7' THEN
        EXECUTE format('DROP POLICY %I ON public.%I', $p$highlights_write$p$, 'highlights');
      ELSIF (SELECT roles::text FROM pg_policies WHERE schemaname='public'
             AND tablename='highlights' AND policyname=$p$highlights_write$p$) = '{service_role}' THEN
        NULL; -- 이미 스코핑된 재실행 — skip
      ELSE
        RAISE EXCEPTION 'advisor_step2: policy drift on %.% — refusing', 'highlights', $p$highlights_write$p$;
      END IF;
    END IF;
  END IF;
  IF to_regclass('public.comments') IS NOT NULL THEN
    cur_md5 := pg_temp._adv2_policy_md5('comments', $p$Authors delete own comments$p$);
    IF cur_md5 IS NOT NULL THEN
      IF cur_md5 = '7a327b7dcb64179010d465f8026edaa9' THEN
        EXECUTE format('DROP POLICY %I ON public.%I', $p$Authors delete own comments$p$, 'comments');
      ELSE
        RAISE EXCEPTION 'advisor_step2: policy drift on %.% — refusing', 'comments', $p$Authors delete own comments$p$;
      END IF;
    END IF;
  END IF;
  IF to_regclass('public.comments') IS NOT NULL THEN
    cur_md5 := pg_temp._adv2_policy_md5('comments', $p$Operators delete any comments$p$);
    IF cur_md5 IS NOT NULL THEN
      IF cur_md5 = '475f3dd5db4946667bc163aa986ffc74' THEN
        EXECUTE format('DROP POLICY %I ON public.%I', $p$Operators delete any comments$p$, 'comments');
      ELSE
        RAISE EXCEPTION 'advisor_step2: policy drift on %.% — refusing', 'comments', $p$Operators delete any comments$p$;
      END IF;
    END IF;
  END IF;
  IF to_regclass('public.posts') IS NOT NULL THEN
    cur_md5 := pg_temp._adv2_policy_md5('posts', $p$Authors delete own posts$p$);
    IF cur_md5 IS NOT NULL THEN
      IF cur_md5 = '7a327b7dcb64179010d465f8026edaa9' THEN
        EXECUTE format('DROP POLICY %I ON public.%I', $p$Authors delete own posts$p$, 'posts');
      ELSE
        RAISE EXCEPTION 'advisor_step2: policy drift on %.% — refusing', 'posts', $p$Authors delete own posts$p$;
      END IF;
    END IF;
  END IF;
  IF to_regclass('public.posts') IS NOT NULL THEN
    cur_md5 := pg_temp._adv2_policy_md5('posts', $p$Operators delete any posts$p$);
    IF cur_md5 IS NOT NULL THEN
      IF cur_md5 = '475f3dd5db4946667bc163aa986ffc74' THEN
        EXECUTE format('DROP POLICY %I ON public.%I', $p$Operators delete any posts$p$, 'posts');
      ELSE
        RAISE EXCEPTION 'advisor_step2: policy drift on %.% — refusing', 'posts', $p$Operators delete any posts$p$;
      END IF;
    END IF;
  END IF;
  IF to_regclass('public.announcements') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='announcements' AND policyname=$p$Service role full access on announcements$p$)
  THEN
    EXECUTE $c$CREATE POLICY "Service role full access on announcements" ON public.announcements FOR ALL TO service_role USING (((select auth.role()) = 'service_role'::text)) WITH CHECK (((select auth.role()) = 'service_role'::text))$c$;
  END IF;
  IF to_regclass('public.channel_pool') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='channel_pool' AND policyname=$p$channel_pool_service_write$p$)
  THEN
    EXECUTE $c$CREATE POLICY "channel_pool_service_write" ON public.channel_pool FOR ALL TO service_role USING (((select auth.role()) = 'service_role'::text)) WITH CHECK (((select auth.role()) = 'service_role'::text))$c$;
  END IF;
  IF to_regclass('public.videos') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='videos' AND policyname=$p$videos_service_write$p$)
  THEN
    EXECUTE $c$CREATE POLICY "videos_service_write" ON public.videos FOR ALL TO service_role USING (((select auth.role()) = 'service_role'::text)) WITH CHECK (((select auth.role()) = 'service_role'::text))$c$;
  END IF;
  IF to_regclass('public.highlights') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='highlights' AND policyname=$p$highlights_write$p$)
  THEN
    EXECUTE $c$CREATE POLICY "highlights_write" ON public.highlights FOR ALL TO service_role USING (true)$c$;
  END IF;
  IF to_regclass('public.comments') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='comments' AND policyname=$p$comments_delete_author_or_operator$p$)
  THEN
    EXECUTE $c$CREATE POLICY "comments_delete_author_or_operator" ON public.comments FOR DELETE TO public USING ((((select auth.uid()) = author_id)) OR ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.is_operator = true))))))$c$;
  END IF;
  IF to_regclass('public.posts') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='posts' AND policyname=$p$posts_delete_author_or_operator$p$)
  THEN
    EXECUTE $c$CREATE POLICY "posts_delete_author_or_operator" ON public.posts FOR DELETE TO public USING ((((select auth.uid()) = author_id)) OR ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.is_operator = true))))))$c$;
  END IF;
END $mig$;

-- ---- Part A: initplan 래핑 (표현식 구조 불변) ----------------------------
DO $mig$
DECLARE r record; cur_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('admin_page_views', $p0$apv_insert_own$p0$, 'f2ddbc79e24daf371a14e31c92b8402a', NULL, $c0$(user_id = (select auth.uid()))$c0$),
    ('api_fallback_events', $p1$Admin read access$p1$, 'fa52d1b14bccd9d88f9967861fa595ac', $u1$((((select auth.jwt()) ->> 'role'::text) = 'admin'::text) OR (((select auth.jwt()) ->> 'role'::text) = 'service_role'::text))$u1$, NULL),
    ('api_fallback_events', $p2$Service role write access$p2$, '00e7a0a29e35052acf386d5e984756af', NULL, $c2$(((select auth.jwt()) ->> 'role'::text) = 'service_role'::text)$c2$),
    ('channel_discovery_candidates', $p3$cdc_service_all$p3$, '445e2c3db9ca7ceee07b914252592306', $u3$((select auth.role()) = 'service_role'::text)$u3$, $c3$((select auth.role()) = 'service_role'::text)$c3$),
    ('channel_discovery_lock', $p4$cdl_service_all$p4$, '445e2c3db9ca7ceee07b914252592306', $u4$((select auth.role()) = 'service_role'::text)$u4$, $c4$((select auth.role()) = 'service_role'::text)$c4$),
    ('channel_discovery_runs', $p5$cdr_service_all$p5$, '445e2c3db9ca7ceee07b914252592306', $u5$((select auth.role()) = 'service_role'::text)$u5$, $c5$((select auth.role()) = 'service_role'::text)$c5$),
    ('chat_messages', $p6$Auth users send$p6$, '2c7f900abd70a246e4fe36e8ce69bc85', NULL, $c6$((select auth.uid()) = user_id)$c6$),
    ('comment_likes', $p7$Auth users create comment likes$p7$, '2c7f900abd70a246e4fe36e8ce69bc85', NULL, $c7$((select auth.uid()) = user_id)$c7$),
    ('comment_likes', $p8$Users delete own comment likes$p8$, 'f655cc3d2e5837c2fa67b191581fa78c', $u8$((select auth.uid()) = user_id)$u8$, NULL),
    ('comments', $p9$Auth users create$p9$, 'b8a1f4053399c5bc57c03bf847143734', NULL, $c9$((select auth.uid()) = author_id)$c9$),
    ('comments', $p10$Authors update own comments$p10$, 'b5ded90a285c492ee2c3f5a2fe40aba6', $u10$((select auth.uid()) = author_id)$u10$, $c10$((select auth.uid()) = author_id)$c10$),
    ('device_push_tokens', $p11$Users delete own device token$p11$, 'f655cc3d2e5837c2fa67b191581fa78c', $u11$((select auth.uid()) = user_id)$u11$, NULL),
    ('device_push_tokens', $p12$Users insert own device token$p12$, '2c7f900abd70a246e4fe36e8ce69bc85', NULL, $c12$((select auth.uid()) = user_id)$c12$),
    ('device_push_tokens', $p13$Users read own device token$p13$, 'f655cc3d2e5837c2fa67b191581fa78c', $u13$((select auth.uid()) = user_id)$u13$, NULL),
    ('device_push_tokens', $p14$Users update own device token$p14$, '82abfb42f92531c0a99f9ad1a9603de3', $u14$((select auth.uid()) = user_id)$u14$, $c14$((select auth.uid()) = user_id)$c14$),
    ('dm_conversations', $p15$dm_conv_insert$p15$, 'adb9e3b462b4c10aa0cca8e134f9b5a1', NULL, $c15$((user1_id IS NOT NULL) AND (user2_id IS NOT NULL) AND (((select auth.uid()) = user1_id) OR ((select auth.uid()) = user2_id)) AND (NOT (EXISTS ( SELECT 1
   FROM user_blocks
  WHERE (((user_blocks.blocker_id = dm_conversations.user1_id) AND (user_blocks.blocked_id = dm_conversations.user2_id)) OR ((user_blocks.blocker_id = dm_conversations.user2_id) AND (user_blocks.blocked_id = dm_conversations.user1_id)))))))$c15$),
    ('dm_conversations', $p16$dm_conv_select$p16$, '96535fd74a2b06d594ea10178393009a', $u16$(((select auth.uid()) = user1_id) OR ((select auth.uid()) = user2_id))$u16$, NULL),
    ('dm_conversations', $p17$dm_conv_update$p17$, '96535fd74a2b06d594ea10178393009a', $u17$(((select auth.uid()) = user1_id) OR ((select auth.uid()) = user2_id))$u17$, NULL),
    ('dm_messages', $p18$dm_msg_insert$p18$, 'f06d3745f0bdc68b8d794ba9f74bf37c', NULL, $c18$(((select auth.uid()) = sender_id) AND (EXISTS ( SELECT 1
   FROM dm_conversations conversation
  WHERE ((conversation.id = dm_messages.conversation_id) AND (conversation.user1_id IS NOT NULL) AND (conversation.user2_id IS NOT NULL) AND ((conversation.user1_id = (select auth.uid())) OR (conversation.user2_id = (select auth.uid()))) AND (NOT (EXISTS ( SELECT 1
           FROM user_blocks
          WHERE (((user_blocks.blocker_id = conversation.user1_id) AND (user_blocks.blocked_id = conversation.user2_id)) OR ((user_blocks.blocker_id = conversation.user2_id) AND (user_blocks.blocked_id = conversation.user1_id))))))))))$c18$),
    ('dm_messages', $p19$dm_msg_select$p19$, '0ca52988b48f5a01cca52b3bd741439b', $u19$(EXISTS ( SELECT 1
   FROM dm_conversations c
  WHERE ((c.id = dm_messages.conversation_id) AND ((c.user1_id = (select auth.uid())) OR (c.user2_id = (select auth.uid()))))))$u19$, NULL),
    ('dm_messages', $p20$dm_msg_update$p20$, '0ca52988b48f5a01cca52b3bd741439b', $u20$(EXISTS ( SELECT 1
   FROM dm_conversations c
  WHERE ((c.id = dm_messages.conversation_id) AND ((c.user1_id = (select auth.uid())) OR (c.user2_id = (select auth.uid()))))))$u20$, NULL),
    ('dm_reports', $p21$reports_insert$p21$, '640cb2a984ea719a2876f36a3b7afce5', NULL, $c21$((select auth.uid()) = reporter_id)$c21$),
    ('dm_reports', $p22$reports_select$p22$, 'cee773c3c9e3e5f09b7fdcd9b56c5b2c', $u22$((select auth.uid()) = reporter_id)$u22$, NULL),
    ('feedback', $p23$feedback_insert$p23$, '84ae5cda9efd7e8e5f0241bcf782b87b', NULL, $c23$((select auth.uid()) IS NOT NULL)$c23$),
    ('feedback', $p24$feedback_read$p24$, '08dca56885055e89c099f60d6e865aa8', $u24$((user_id = (select auth.uid())) OR (status = ANY (ARRAY['resolved'::text, 'rejected'::text, 'duplicate'::text])))$u24$, NULL),
    ('feedback_votes', $p25$feedback_vote_insert$p25$, 'f2ddbc79e24daf371a14e31c92b8402a', NULL, $c25$(user_id = (select auth.uid()))$c25$),
    ('gif_collector_queue', $p26$gif_collector_queue_service_all$p26$, '445e2c3db9ca7ceee07b914252592306', $u26$((select auth.role()) = 'service_role'::text)$u26$, $c26$((select auth.role()) = 'service_role'::text)$c26$),
    ('invitations', $p27$Create invites$p27$, 'e3b6a7386cf4d3ca0c6df493c320bfb0', NULL, $c27$((select auth.uid()) = inviter_id)$c27$),
    ('invitations', $p28$Read own invites$p28$, '571eeb7890d380cb9010ac45f76ed0c2', $u28$(((select auth.uid()) = inviter_id) OR ((select auth.uid()) = invitee_id))$u28$, NULL),
    ('invite_refill_log', $p29$Users read own refill$p29$, 'f655cc3d2e5837c2fa67b191581fa78c', $u29$((select auth.uid()) = user_id)$u29$, NULL),
    ('likes', $p30$Auth users toggle$p30$, '2c7f900abd70a246e4fe36e8ce69bc85', NULL, $c30$((select auth.uid()) = user_id)$c30$),
    ('likes', $p31$Users delete own$p31$, 'f655cc3d2e5837c2fa67b191581fa78c', $u31$((select auth.uid()) = user_id)$u31$, NULL),
    ('live_activity_start_tokens', $p32$own la start token delete$p32$, 'f655cc3d2e5837c2fa67b191581fa78c', $u32$((select auth.uid()) = user_id)$u32$, NULL),
    ('live_activity_start_tokens', $p33$own la start token insert$p33$, '2c7f900abd70a246e4fe36e8ce69bc85', NULL, $c33$((select auth.uid()) = user_id)$c33$),
    ('live_activity_start_tokens', $p34$own la start token update$p34$, '82abfb42f92531c0a99f9ad1a9603de3', $u34$((select auth.uid()) = user_id)$u34$, $c34$((select auth.uid()) = user_id)$c34$),
    ('live_activity_tokens', $p35$own live activity tokens delete$p35$, 'f655cc3d2e5837c2fa67b191581fa78c', $u35$((select auth.uid()) = user_id)$u35$, NULL),
    ('live_activity_tokens', $p36$own live activity tokens insert$p36$, '2c7f900abd70a246e4fe36e8ce69bc85', NULL, $c36$((select auth.uid()) = user_id)$c36$),
    ('live_activity_tokens', $p37$own live activity tokens update$p37$, '82abfb42f92531c0a99f9ad1a9603de3', $u37$((select auth.uid()) = user_id)$u37$, $c37$((select auth.uid()) = user_id)$c37$),
    ('notification_prefs', $p38$Users insert own notification prefs$p38$, '2c7f900abd70a246e4fe36e8ce69bc85', NULL, $c38$((select auth.uid()) = user_id)$c38$),
    ('notification_prefs', $p39$Users read own notification prefs$p39$, 'f655cc3d2e5837c2fa67b191581fa78c', $u39$((select auth.uid()) = user_id)$u39$, NULL),
    ('notification_prefs', $p40$Users update own notification prefs$p40$, '82abfb42f92531c0a99f9ad1a9603de3', $u40$((select auth.uid()) = user_id)$u40$, $c40$((select auth.uid()) = user_id)$c40$),
    ('posts', $p41$Auth users create$p41$, 'b8a1f4053399c5bc57c03bf847143734', NULL, $c41$((select auth.uid()) = author_id)$c41$),
    ('posts', $p42$Authors update own$p42$, '7a327b7dcb64179010d465f8026edaa9', $u42$((select auth.uid()) = author_id)$u42$, NULL),
    ('prediction_votes', $p43$Auth users vote$p43$, '2c7f900abd70a246e4fe36e8ce69bc85', NULL, $c43$((select auth.uid()) = user_id)$c43$),
    ('profile_nickname_changes', $p44$Users read own nickname changes$p44$, 'f655cc3d2e5837c2fa67b191581fa78c', $u44$((select auth.uid()) = user_id)$u44$, NULL),
    ('profiles', $p45$Users create own$p45$, 'bc1b8bba678bde72fd7966efa1c87c2a', NULL, $c45$((select auth.uid()) = id)$c45$),
    ('profiles', $p46$Users update own$p46$, 'cc00666ac5d81806b4129769e28761f3', $u46$((select auth.uid()) = id)$u46$, NULL),
    ('push_subscriptions', $p47$Users read own$p47$, 'f655cc3d2e5837c2fa67b191581fa78c', $u47$((select auth.uid()) = user_id)$u47$, NULL),
    ('reports', $p48$Users create reports$p48$, '640cb2a984ea719a2876f36a3b7afce5', NULL, $c48$((select auth.uid()) = reporter_id)$c48$),
    ('reports', $p49$Users read own reports$p49$, 'cee773c3c9e3e5f09b7fdcd9b56c5b2c', $u49$((select auth.uid()) = reporter_id)$u49$, NULL),
    ('season_predictions', $p50$Users create own$p50$, '2c7f900abd70a246e4fe36e8ce69bc85', NULL, $c50$((select auth.uid()) = user_id)$c50$),
    ('season_predictions', $p51$Users update own$p51$, 'f655cc3d2e5837c2fa67b191581fa78c', $u51$((select auth.uid()) = user_id)$u51$, NULL),
    ('tester_signups', $p52$Service role full access on tester_signups$p52$, '445e2c3db9ca7ceee07b914252592306', $u52$((select auth.role()) = 'service_role'::text)$u52$, $c52$((select auth.role()) = 'service_role'::text)$c52$),
    ('ticket_transfers', $p53$Auth users create$p53$, 'b8a1f4053399c5bc57c03bf847143734', NULL, $c53$((select auth.uid()) = author_id)$c53$),
    ('ticket_transfers', $p54$Authors delete own$p54$, '7a327b7dcb64179010d465f8026edaa9', $u54$((select auth.uid()) = author_id)$u54$, NULL),
    ('ticket_transfers', $p55$Authors update own$p55$, '7a327b7dcb64179010d465f8026edaa9', $u55$((select auth.uid()) = author_id)$u55$, NULL),
    ('user_blocks', $p56$blocks_delete$p56$, 'fcc9b253bcf12cc261ea2f361ae50935', $u56$((select auth.uid()) = blocker_id)$u56$, NULL),
    ('user_blocks', $p57$blocks_insert$p57$, '9be567f5ec4706f04b3fe4b3e2cd5557', NULL, $c57$((select auth.uid()) = blocker_id)$c57$),
    ('user_blocks', $p58$blocks_select$p58$, 'a64df04219e81678d3a5fb0a6f9bd14a', $u58$(((select auth.uid()) = blocker_id) OR ((select auth.uid()) = blocked_id))$u58$, NULL),
    ('youtube_quota_ledger', $p59$yql_service_all$p59$, '445e2c3db9ca7ceee07b914252592306', $u59$((select auth.role()) = 'service_role'::text)$u59$, $c59$((select auth.role()) = 'service_role'::text)$c59$)
  ) AS t(tbl, pol, expected_md5, new_using, new_check)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN CONTINUE; END IF;
    cur_md5 := pg_temp._adv2_policy_md5(r.tbl, r.pol);
    IF cur_md5 IS NULL THEN CONTINUE; END IF; -- 정책 부재 (clean chain)
    IF cur_md5 <> r.expected_md5 THEN
      IF NOT pg_temp._adv2_has_bare_auth(r.tbl, r.pol) THEN
        CONTINUE; -- 이미 래핑됨 (멱등 재실행)
      END IF;
      RAISE EXCEPTION 'advisor_step2: policy drift on %.% — refusing', r.tbl, r.pol;
    END IF;
    EXECUTE format('ALTER POLICY %I ON public.%I %s %s', r.pol, r.tbl,
      CASE WHEN r.new_using IS NOT NULL THEN 'USING (' || r.new_using || ')' ELSE '' END,
      CASE WHEN r.new_check IS NOT NULL THEN 'WITH CHECK (' || r.new_check || ')' ELSE '' END);
  END LOOP;
END $mig$;

DROP FUNCTION IF EXISTS pg_temp._adv2_policy_md5(text, text);
DROP FUNCTION IF EXISTS pg_temp._adv2_has_bare_auth(text, text);
