-- Supabase advisor 1단계 (저위험) — 2026-08-13 하린아빠 승인 (#infra 1786505729.677579)
-- ① function_search_path_mutable 9건: 함수 search_path 고정 (기존 repo 컨벤션 = public)
--    시그니처는 production pg_proc 실측 (2026-08-13).
-- ② duplicate_index 3건: 정의가 완전히 동일한 중복 인덱스 제거.
--    유지 = migration에 정의된 이름(idx_dm_conversations_*, idx_posts_player_tags),
--    삭제 = migration에 없는 stray(idx_dm_conv_*, idx_posts_player_tags_gin).
-- ③ HIBP(auth_leaked_password_protection)는 Auth 설정이라 migration 아님 —
--    Management API로 password_hibp_enabled=true 적용 완료 (2026-08-13 12:5x KST).
--
-- 삼순 2차 NO-GO 반영 (exact 3ac8d25d1):
--  * keeper usable 검증 추가 — pg_indexes는 invalid index도 노출하므로, keeper가
--    indisvalid/indisready/indislive가 아니면 valid target을 지워 usable 0개가 될 수
--    있다. pg_index로 fail-closed 확인 후에만 DROP.
--  * rollback을 placeholder 없는 실행형 SQL로 교체.
--  * 지속 회귀: scripts/qa/advisor-step1-migration-gate.ts (PGlite에서 이 파일을
--    그대로 replay — clean-chain/prod-like/unusable-keeper RED/drift RED/keeper 부재 RED)
--
-- 삼순 1차 NO-GO 반영 (exact a028ec19b):
--  * ALTER FUNCTION은 to_regprocedure 조건부 — clean migration chain에 없는 함수
--    (예: upsert_game_event_state, production 전용)에서 42883으로 replay가 깨지지 않는다.
--    단, production에는 9개 전부 존재함을 실측했으므로 실제 적용에서는 9건 모두 ALTER 된다.
--  * DROP은 fail-closed: keeper 부재 또는 정의 불일치면 RAISE EXCEPTION (drift 시
--    유일 인덱스 삭제 차단). target 부재(clean chain)는 no-op.
--  * lock_timeout 5s — DDL이 라이브 트래픽 잠금 대기로 지연되면 실패하고 재시도한다.
--
-- rollback (수동, 전문 실행형):
--   ALTER FUNCTION public.notify_push_dispatch() RESET search_path;
--   ALTER FUNCTION public.upsert_game_event_state(text, jsonb, jsonb) RESET search_path;
--   ALTER FUNCTION public.guard_profiles_is_operator() RESET search_path;
--   ALTER FUNCTION public.leaderboard_internal_user_ids() RESET search_path;
--   ALTER FUNCTION public.urgent_notice_sender_id() RESET search_path;
--   ALTER FUNCTION public.guard_dm_message_dedup_key() RESET search_path;
--   ALTER FUNCTION public._assert_quota_date(text) RESET search_path;
--   ALTER FUNCTION public._yt_quota_hard_max() RESET search_path;
--   ALTER FUNCTION public.venue_story_comment_post(bigint, uuid, text, text) RESET search_path;
--   CREATE INDEX idx_dm_conv_user1_last_message ON public.dm_conversations
--     USING btree (user1_id, last_message_at DESC, id DESC);
--   CREATE INDEX idx_dm_conv_user2_last_message ON public.dm_conversations
--     USING btree (user2_id, last_message_at DESC, id DESC);
--   CREATE INDEX idx_posts_player_tags_gin ON public.posts USING gin (player_tags);

SET lock_timeout = '5s';

-- ① search_path 고정 (존재할 때만 — clean replay 안전) ---------------------
DO $$
DECLARE
  sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.notify_push_dispatch()',
    'public.upsert_game_event_state(text, jsonb, jsonb)',
    'public.guard_profiles_is_operator()',
    'public.leaderboard_internal_user_ids()',
    'public.urgent_notice_sender_id()',
    'public.guard_dm_message_dedup_key()',
    'public._assert_quota_date(text)',
    'public._yt_quota_hard_max()',
    'public.venue_story_comment_post(bigint, uuid, text, text)'
  ] LOOP
    IF to_regprocedure(sig) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public', sig);
    END IF;
  END LOOP;
END $$;

-- ② 중복 인덱스 제거 (fail-closed) ----------------------------------------
-- keeper 부재/정의 불일치 = EXCEPTION(중단), target 부재 = no-op.
DO $$
DECLARE
  pair record;
  keeper_def text;
  target_def text;
  keeper_usable boolean;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('idx_dm_conversations_user1_last_message', 'idx_dm_conv_user1_last_message'),
      ('idx_dm_conversations_user2_last_message', 'idx_dm_conv_user2_last_message'),
      ('idx_posts_player_tags',                   'idx_posts_player_tags_gin')
    ) AS t(keeper, target)
  LOOP
    SELECT indexdef INTO target_def FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = pair.target;
    IF target_def IS NULL THEN
      CONTINUE; -- stray가 없는 환경(clean chain) — 정리할 것 없음
    END IF;

    SELECT indexdef INTO keeper_def FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = pair.keeper;
    IF keeper_def IS NULL THEN
      RAISE EXCEPTION 'advisor_step1: keeper index % missing — refusing to drop %',
        pair.keeper, pair.target;
    END IF;

    -- keeper가 usable인지 fail-closed 확인 — pg_indexes는 invalid index도 노출하므로
    -- indisvalid/indisready/indislive를 pg_index에서 직접 본다 (삼순 2차 P0).
    SELECT i.indisvalid AND i.indisready AND i.indislive INTO keeper_usable
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = pair.keeper;
    IF keeper_usable IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'advisor_step1: keeper index % is not usable (invalid/not-ready/not-live) — refusing to drop %',
        pair.keeper, pair.target;
    END IF;

    -- 이름 토큰만 치환해 정의 문자열이 byte-동일한지 확인 (drift 시 fail-close)
    IF replace(keeper_def, pair.keeper, '__IDX__')
       IS DISTINCT FROM replace(target_def, pair.target, '__IDX__') THEN
      RAISE EXCEPTION 'advisor_step1: index definition drift between % and % — refusing to drop',
        pair.keeper, pair.target;
    END IF;

    EXECUTE format('DROP INDEX public.%I', pair.target);
  END LOOP;
END $$;
