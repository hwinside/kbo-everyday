-- 건의함(피드백) 회신 대화를 운영팀 쪽지함 수신함에 노출한다.
--
-- 문제: admin_dm_inbox_page 는 "유저 발신 메시지 1건+" 대화만 노출한다.
-- 건의함(피드백 폼)으로 인입된 건은 유저가 DM 을 보낸 게 아니라 피드백을 남긴 것이라,
-- cs-feedback 에서 쪽지로 회신하면 대화에 운영팀 발신만 존재 → 수신함에서 빠진다.
--
-- 해결(최소 변경, additive): dm_conversations 에 origin 컬럼을 추가하고(기본 'dm'),
-- 피드백 회신 시 대화를 origin='feedback' 으로 마킹한다.
-- 수신함 노출 조건을 "유저 발신 1건+ OR origin='feedback'" 으로 확장한다.
-- 일반 유저 쪽지함(useDM.ts)과 broadcast 선발신 대화는 영향받지 않는다.

ALTER TABLE public.dm_conversations
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'dm';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dm_conversations_origin_check'
  ) THEN
    ALTER TABLE public.dm_conversations
      ADD CONSTRAINT dm_conversations_origin_check CHECK (origin IN ('dm', 'feedback'));
  END IF;
END $$;

-- RETURNS TABLE 에 origin 컬럼을 추가하므로 기존 함수를 먼저 DROP 한다
-- (CREATE OR REPLACE 로는 반환 타입을 변경할 수 없다).
DROP FUNCTION IF EXISTS public.admin_dm_inbox_page(UUID, TIMESTAMPTZ, UUID, INT);

CREATE FUNCTION public.admin_dm_inbox_page(
  p_system_user_id UUID,
  p_cursor_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 51
)
RETURNS TABLE (
  id UUID,
  other_user_id UUID,
  other_nickname TEXT,
  other_team_id INT,
  last_message TEXT,
  last_message_at TIMESTAMPTZ,
  unread_count BIGINT,
  user_msg_count BIGINT,
  sys_msg_count BIGINT,
  origin TEXT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH eligible AS MATERIALIZED (
    SELECT
      c.*,
      COALESCE(
        c.last_message_at,
        (SELECT MAX(fallback_message.created_at)
         FROM public.dm_messages fallback_message
         WHERE fallback_message.conversation_id = c.id),
        c.created_at
      ) AS sort_at
    FROM public.dm_conversations c
    WHERE c.user1_id = p_system_user_id
      AND (
        c.origin = 'feedback'
        OR EXISTS (
          SELECT 1
          FROM public.dm_messages eligibility_message
          WHERE eligibility_message.conversation_id = c.id
            AND eligibility_message.sender_id <> p_system_user_id
        )
      )

    UNION ALL

    SELECT
      c.*,
      COALESCE(
        c.last_message_at,
        (SELECT MAX(fallback_message.created_at)
         FROM public.dm_messages fallback_message
         WHERE fallback_message.conversation_id = c.id),
        c.created_at
      ) AS sort_at
    FROM public.dm_conversations c
    WHERE c.user2_id = p_system_user_id
      AND (
        c.origin = 'feedback'
        OR EXISTS (
          SELECT 1
          FROM public.dm_messages eligibility_message
          WHERE eligibility_message.conversation_id = c.id
            AND eligibility_message.sender_id <> p_system_user_id
        )
      )
  ), page AS MATERIALIZED (
    SELECT c.*
    FROM eligible c
    WHERE p_cursor_at IS NULL
       OR c.sort_at < p_cursor_at
       OR (c.sort_at = p_cursor_at AND c.id < p_cursor_id)
    ORDER BY c.sort_at DESC, c.id DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 101)
  )
  SELECT
    c.id,
    CASE WHEN c.user1_id = p_system_user_id THEN c.user2_id ELSE c.user1_id END AS other_user_id,
    COALESCE(profile.nickname::TEXT, '알 수 없음') AS other_nickname,
    profile.team_id,
    c.last_message,
    c.sort_at AS last_message_at,
    counts.unread_count,
    counts.user_msg_count,
    counts.sys_msg_count,
    c.origin
  FROM page c
  LEFT JOIN public.profiles profile
    ON profile.id = CASE WHEN c.user1_id = p_system_user_id THEN c.user2_id ELSE c.user1_id END
  CROSS JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (
        WHERE message.sender_id <> p_system_user_id AND message.is_read = FALSE
      )::BIGINT AS unread_count,
      COUNT(*) FILTER (WHERE message.sender_id <> p_system_user_id)::BIGINT AS user_msg_count,
      COUNT(*) FILTER (WHERE message.sender_id = p_system_user_id)::BIGINT AS sys_msg_count
    FROM public.dm_messages message
    WHERE message.conversation_id = c.id
  ) counts
  ORDER BY c.sort_at DESC, c.id DESC;
$$;

REVOKE ALL ON FUNCTION public.admin_dm_inbox_page(UUID, TIMESTAMPTZ, UUID, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dm_inbox_page(UUID, TIMESTAMPTZ, UUID, INT)
  TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 원자 운영팀 발송 RPC (삼순 round2 blocker: 발송/marker 원자성)
--
-- 대화 upsert + 메시지 INSERT + preview/origin 확정을 한 트랜잭션(함수)으로 묶는다.
-- 메시지 INSERT 또는 preview/origin UPDATE 가 실패하면 전부 rollback → 빈 대화·
-- 숨은 대화가 남지 않고, 호출부는 error 를 받아 CS 원클릭 회신을 resolved 처리하지
-- 않는다. 어드민 직접 회신(/api/admin/messages)과 CS 원클릭 회신(sendOpsMessageToUser)이
-- 이 RPC 를 공유한다. 일반 dm/broadcast 발송은 p_origin='dm' 으로 origin 을 유지한다.
--
-- p_dedup_key 지정 시: 같은 대화·운영팀 발신으로 이미 있으면 멱등 성공(재발송 방지),
-- 다른 대화/발신자의 키 충돌이면 위조 의심으로 예외 → 전체 rollback.
CREATE OR REPLACE FUNCTION public.admin_send_ops_message(
  p_system_user_id UUID,
  p_user_id UUID,
  p_content TEXT DEFAULT '',
  p_image_urls TEXT[] DEFAULT '{}',
  p_preview TEXT DEFAULT NULL,
  p_origin TEXT DEFAULT 'dm',
  p_dedup_key TEXT DEFAULT NULL
)
RETURNS TABLE (conversation_id UUID, deduped BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_u1 UUID;
  v_u2 UUID;
  v_conv UUID;
  v_content TEXT := btrim(COALESCE(p_content, ''));
  v_image_urls TEXT[];
  v_deduped BOOLEAN := false;
BEGIN
  IF p_system_user_id IS NULL OR p_user_id IS NULL OR p_user_id = p_system_user_id THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid recipient';
  END IF;
  IF p_origin NOT IN ('dm', 'feedback') THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid origin';
  END IF;

  SELECT COALESCE(array_agg(url), '{}')
  INTO v_image_urls
  FROM unnest(COALESCE(p_image_urls, '{}')) AS url
  WHERE nullif(btrim(url), '') IS NOT NULL;

  IF v_content = '' AND COALESCE(cardinality(v_image_urls), 0) = 0 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'empty message';
  END IF;

  -- 대화 pair 는 정렬된 (user1,user2) unique 로 upsert (원자적 방 생성)
  IF p_system_user_id::text < p_user_id::text THEN
    v_u1 := p_system_user_id; v_u2 := p_user_id;
  ELSE
    v_u1 := p_user_id; v_u2 := p_system_user_id;
  END IF;

  INSERT INTO public.dm_conversations (user1_id, user2_id)
  VALUES (v_u1, v_u2)
  ON CONFLICT (user1_id, user2_id)
  DO UPDATE SET user1_id = excluded.user1_id
  RETURNING id INTO v_conv;

  -- 메시지 INSERT (AFTER INSERT 트리거가 preview 갱신). dedup_key 있으면 멱등 처리.
  BEGIN
    IF p_dedup_key IS NOT NULL THEN
      INSERT INTO public.dm_messages (conversation_id, sender_id, content, image_urls, dedup_key)
      VALUES (v_conv, p_system_user_id, v_content, v_image_urls, p_dedup_key);
    ELSE
      INSERT INTO public.dm_messages (conversation_id, sender_id, content, image_urls)
      VALUES (v_conv, p_system_user_id, v_content, v_image_urls);
    END IF;
  EXCEPTION WHEN unique_violation THEN
    IF p_dedup_key IS NULL THEN RAISE; END IF;
    -- 같은 대화·운영팀 발신으로 이미 존재하면 멱등 성공, 아니면 위조 의심 → rollback
    IF NOT EXISTS (
      SELECT 1 FROM public.dm_messages m
      WHERE m.dedup_key = p_dedup_key
        AND m.conversation_id = v_conv
        AND m.sender_id = p_system_user_id
    ) THEN
      RAISE EXCEPTION USING errcode = '23505', message = 'dedup_key_conflict_foreign';
    END IF;
    v_deduped := true;
  END;

  IF v_deduped THEN
    -- 재발송(멱등): 목록 순서를 흔들지 않고, 피드백 회신이면 origin 만 보정한다.
    IF p_origin = 'feedback' THEN
      UPDATE public.dm_conversations SET origin = 'feedback'
      WHERE id = v_conv AND origin <> 'feedback';
    END IF;
  ELSE
    -- 신규 발송: preview(앱 truncate 형)로 확정 + 피드백이면 origin 마킹.
    -- 이 UPDATE 가 실패하면 함수 전체 rollback → 메시지/대화 모두 롤백.
    UPDATE public.dm_conversations
    SET last_message = COALESCE(nullif(btrim(p_preview), ''), last_message),
        last_message_at = now(),
        origin = CASE WHEN p_origin = 'feedback' THEN 'feedback' ELSE origin END
    WHERE id = v_conv;
  END IF;

  RETURN QUERY SELECT v_conv, v_deduped;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_send_ops_message(UUID, UUID, TEXT, TEXT[], TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_send_ops_message(UUID, UUID, TEXT, TEXT[], TEXT, TEXT, TEXT)
  TO service_role;
