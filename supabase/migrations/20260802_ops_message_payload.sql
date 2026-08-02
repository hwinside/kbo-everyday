-- 운영팀 발신 쪽지에 구조화 payload 를 함께 저장한다 (2026-08-02).
--
-- 배경: 야잘알봇 답변에 답변 유형(사전/캐시/LLM/모름/차단/인사…)별 마스코트를 붙이려면
-- 클라가 그 유형을 알아야 한다. 답변 텍스트를 클라에서 상수와 대조하는 방식은
-- 문구가 바뀌는 순간 조용히 깨지므로, 서버가 저장 시점에 유형을 기록한다(SSOT).
--
-- dm_messages.payload 컬럼은 이미 존재한다(20260711_news_clipping.sql). 여기서는
-- admin_send_ops_message 가 그 컬럼에 값을 넣을 수 있게 파라미터 하나를 추가한다.
--
-- ⚠️ CREATE OR REPLACE 로는 파라미터를 추가할 수 없다. 인자 개수가 다르면 새 함수가
-- 만들어지고, DEFAULT 때문에 기존 7-인자 호출이 두 함수 사이에서 ambiguous 가 된다.
-- 그래서 기존 시그니처를 명시적으로 DROP 한 뒤 8-인자로 다시 만든다.
DROP FUNCTION IF EXISTS public.admin_send_ops_message(UUID, UUID, TEXT, TEXT[], TEXT, TEXT, TEXT);

-- ⚠️ CREATE OR REPLACE 여야 한다. 재적용 시 8-인자 함수가 이미 있으면
-- 순수 CREATE 는 42723 으로 죽는다(같은 유형으로 #1050 Vercel prebuild 가 실제로 깨졌다).
-- 위 DROP 은 **구 7-인자** 시그니처만 지우므로, 새 시그니처는 REPLACE 로 멱등하게 둔다.
CREATE OR REPLACE FUNCTION public.admin_send_ops_message(
  p_system_user_id UUID,
  p_user_id UUID,
  p_content TEXT DEFAULT '',
  p_image_urls TEXT[] DEFAULT '{}',
  p_preview TEXT DEFAULT NULL,
  p_origin TEXT DEFAULT 'dm',
  p_dedup_key TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT NULL
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
      INSERT INTO public.dm_messages (conversation_id, sender_id, content, image_urls, dedup_key, payload)
      VALUES (v_conv, p_system_user_id, v_content, v_image_urls, p_dedup_key, p_payload);
    ELSE
      INSERT INTO public.dm_messages (conversation_id, sender_id, content, image_urls, payload)
      VALUES (v_conv, p_system_user_id, v_content, v_image_urls, p_payload);
    END IF;
  EXCEPTION WHEN unique_violation THEN
    IF p_dedup_key IS NULL THEN RAISE; END IF;
    -- 멱등 성공은 같은 대화·운영팀 발신·**같은 payload(content+image)**까지 일치할 때만.
    -- 기존 verifyOpsMessageByDedupKey 계약과 동일: 내용이 다르면(broadcast/blind-notify가
    -- 다른 문안을 같은 키로 발송) 위조/오송 의심으로 23505 → 전체 rollback.
    --
    -- payload 를 쓰는 호출자는 같은 의미값까지 동일해야 멱등 성공이다. 기존
    -- CS/broadcast/blind-notify는 p_payload=NULL이므로 기존 재발송 계약은 불변이다.
    IF NOT EXISTS (
      SELECT 1 FROM public.dm_messages m
      WHERE m.dedup_key = p_dedup_key
        AND m.conversation_id = v_conv
        AND m.sender_id = p_system_user_id
        AND m.content = v_content
        AND m.image_urls = v_image_urls
        AND m.payload IS NOT DISTINCT FROM p_payload
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

REVOKE ALL ON FUNCTION public.admin_send_ops_message(UUID, UUID, TEXT, TEXT[], TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_send_ops_message(UUID, UUID, TEXT, TEXT[], TEXT, TEXT, TEXT, JSONB)
  TO service_role;
