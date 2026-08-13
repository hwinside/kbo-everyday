-- Supabase advisor 1단계 (저위험) — 2026-08-13 하린아빠 승인 (#infra 1786505729.677579)
-- ① function_search_path_mutable 9건: 함수 search_path 고정 (기존 repo 컨벤션 = public)
--    시그니처는 production pg_proc 실측 (2026-08-13).
-- ② duplicate_index 3건: 정의가 완전히 동일한 중복 인덱스 제거.
--    유지 = migration에 정의된 이름(idx_dm_conversations_*, idx_posts_player_tags),
--    삭제 = migration에 없는 stray(idx_dm_conv_*, idx_posts_player_tags_gin).
-- ③ HIBP(auth_leaked_password_protection)는 Auth 설정이라 migration 아님 —
--    Management API로 password_hibp_enabled=true 적용 완료 (2026-08-13 12:5x KST).

-- ① search_path 고정 -----------------------------------------------------
ALTER FUNCTION public.notify_push_dispatch() SET search_path = public;
ALTER FUNCTION public.upsert_game_event_state(text, jsonb, jsonb) SET search_path = public;
ALTER FUNCTION public.guard_profiles_is_operator() SET search_path = public;
ALTER FUNCTION public.leaderboard_internal_user_ids() SET search_path = public;
ALTER FUNCTION public.urgent_notice_sender_id() SET search_path = public;
ALTER FUNCTION public.guard_dm_message_dedup_key() SET search_path = public;
ALTER FUNCTION public._assert_quota_date(text) SET search_path = public;
ALTER FUNCTION public._yt_quota_hard_max() SET search_path = public;
ALTER FUNCTION public.venue_story_comment_post(bigint, uuid, text, text) SET search_path = public;

-- ② 중복 인덱스 제거 ------------------------------------------------------
-- idx_dm_conversations_user1_last_message 와 정의 동일 (user1_id, last_message_at DESC, id DESC)
DROP INDEX IF EXISTS public.idx_dm_conv_user1_last_message;
-- idx_dm_conversations_user2_last_message 와 정의 동일 (user2_id, last_message_at DESC, id DESC)
DROP INDEX IF EXISTS public.idx_dm_conv_user2_last_message;
-- idx_posts_player_tags 와 정의 동일 (gin (player_tags))
DROP INDEX IF EXISTS public.idx_posts_player_tags_gin;
